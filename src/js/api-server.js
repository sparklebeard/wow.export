/*!
	wow.export (https://github.com/Kruithne/wow.export)
	License: MIT

	Local HTTP API used to drive wow.export from external tools (e.g. the MCP
	bridge in /mcp). Binds to 127.0.0.1 only and rejects browser-originated
	requests. All operations run through a single queue because the app's
	busy-lock / loading-screen model assumes one task at a time.
 */
const http = require('http');
const path = require('path');
const fsp = require('fs').promises;
const core = require('./core');
const log = require('./log');
const constants = require('./constants');
const modules = require('./modules');
const listfile = require('./casc/listfile');
const BLPFile = require('./casc/blp');
const BufferWrapper = require('./buffer');
const ExportHelper = require('./casc/export-helper');
const InstallType = require('./install-type');
const textureExporter = require('./ui/texture-exporter');

const API_VERSION = 1;
const READY_TIMEOUT_MS = 180_000;

class ApiError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

// --- helpers -----------------------------------------------------------------

const sleep = ms => new Promise(res => setTimeout(res, ms));
const next_frame = () => new Promise(res => requestAnimationFrame(() => res()));

let queue = Promise.resolve();
const enqueue = fn => {
	const run = queue.then(fn, fn);
	queue = run.catch(() => {});
	return run;
};

const module_ctx = () => ({ $core: core, $modules: modules });

const install_type_name = () => {
	const t = core.view.installType;
	if (t === InstallType.CASC) return 'casc';
	if (t === InstallType.MPQ) return 'mpq';
	return 'none';
};

const require_source = (type) => {
	const current = install_type_name();
	if (current === 'none')
		throw new ApiError(409, 'No game source loaded. Load one with /source/casc-local, /source/casc-remote or /source/mpq.');
	if (type && current !== type)
		throw new ApiError(409, `This operation requires a ${type} source, but a ${current} source is loaded.`);
	return current;
};

const wait_until = async (predicate, what, timeout = READY_TIMEOUT_MS) => {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeout)
			throw new ApiError(504, 'Timed out waiting for ' + what);
		await sleep(100);
	}
};

const wait_idle = (what = 'wow.export to become idle') => wait_until(() => core.view.isBusy === 0 && !core.view.isLoading, what);

/** temporarily override config keys for the duration of fn. */
const with_config = async (overrides, fn) => {
	const config = core.view.config;
	const saved = {};
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined || value === null)
			continue;
		saved[key] = config[key];
		config[key] = value;
	}

	try {
		return await fn();
	} finally {
		for (const [key, value] of Object.entries(saved))
			config[key] = value;
	}
};

const to_posix_game_path = p => p.replace(/\\/g, '/');

/** mpq listfile values carry the original-case filename; return it posix-style. */
const mpq_entries = () => core.view.mpq.listfile;

/**
 * resolve a casc file identifier (fileDataID number, numeric string, or listfile path).
 * @returns {{ file_data_id: number, file_name: string }}
 */
const resolve_casc_file = (input) => {
	if (typeof input === 'number' || /^\d+$/.test(String(input))) {
		const file_data_id = Number(input);
		return { file_data_id, file_name: listfile.getByID(file_data_id) ?? listfile.formatUnknownFile(file_data_id) };
	}

	const file_name = listfile.stripFileEntry(String(input)).toLowerCase().replace(/\\/g, '/');
	const file_data_id = listfile.getByFilename(file_name);
	if (file_data_id === undefined)
		throw new ApiError(404, 'File not found in listfile: ' + input);

	return { file_data_id, file_name };
};

const read_file = async (input) => {
	if (install_type_name() === 'mpq') {
		const file_name = to_posix_game_path(String(input));
		const data = core.view.mpq.getFile(file_name);
		if (!data)
			throw new ApiError(404, 'File not found in MPQ: ' + input);
		return { file_name, data: new BufferWrapper(Buffer.from(data)) };
	}

	const { file_data_id, file_name } = resolve_casc_file(input);
	const data = await core.view.casc.getFile(file_data_id);
	return { file_name, file_data_id, data };
};

const parse_query = (url) => Object.fromEntries(url.searchParams.entries());

const read_body = (req) => new Promise((resolve, reject) => {
	const chunks = [];
	req.on('data', c => chunks.push(c));
	req.on('end', () => {
		if (chunks.length === 0)
			return resolve({});
		try {
			resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
		} catch (e) {
			reject(new ApiError(400, 'Invalid JSON body: ' + e.message));
		}
	});
	req.on('error', reject);
});

const require_files = (body) => {
	const files = Array.isArray(body.files) ? body.files : (body.file !== undefined ? [body.file] : null);
	if (!files || files.length === 0)
		throw new ApiError(400, 'Expected "files" (array) or "file".');
	return files;
};

// --- source loading ----------------------------------------------------------

const PRODUCT_LABEL_RE = (product) => {
	const entry = constants.PRODUCTS.find(p => p.product === product);
	if (!entry)
		throw new ApiError(400, 'Unknown product "' + product + '". Known: ' + constants.PRODUCTS.map(p => p.product).join(', '));
	const escaped = entry.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp('^' + escaped + ' [(\\d]');
};

const pick_build = (builds, body) => {
	if (!builds || builds.length === 0)
		throw new ApiError(502, 'No builds available for this source.');

	if (body.build_index !== undefined) {
		const match = builds.find(b => b.buildIndex === Number(body.build_index));
		if (!match)
			throw new ApiError(400, 'Invalid build_index.');
		return match;
	}

	if (body.product) {
		const re = PRODUCT_LABEL_RE(body.product);
		const match = builds.find(b => re.test(b.label));
		if (!match)
			throw new ApiError(404, 'Product "' + body.product + '" not available. Builds: ' + builds.map(b => b.label).join('; '));
		return match;
	}

	return null;
};

const finish_casc_load = async (builds, body) => {
	const build = pick_build(builds, body);
	if (!build)
		return { loaded: false, builds, hint: 'Call again with "product" or "build_index" to load a build.' };

	await modules.source_select.methods.load_install.call(module_ctx(), build.buildIndex);
	await wait_idle('CASC load');

	if (install_type_name() !== 'casc')
		throw new ApiError(500, 'CASC failed to load; see the wow.export runtime log.');

	return { loaded: true, build: build.label, status: status() };
};

const assert_no_source = () => {
	if (install_type_name() !== 'none')
		throw new ApiError(409, 'A source is already loaded. POST /app/restart first, then load the new source.');
};

const load_casc_local = async (body) => {
	assert_no_source();
	if (!body.path)
		throw new ApiError(400, 'Expected "path" to a WoW installation directory.');

	core.view.availableLocalBuilds = null;
	await modules.source_select.methods.open_local_install.call(module_ctx(), body.path);

	const builds = core.view.availableLocalBuilds;
	if (!builds)
		throw new ApiError(400, 'Not a valid CASC World of Warcraft installation: ' + body.path);

	return finish_casc_load(builds, body);
};

const load_casc_remote = async (body) => {
	assert_no_source();

	const region_tag = body.region ?? core.view.selectedCDNRegion?.tag ?? 'us';
	const region = core.view.cdnRegions.find(r => r.tag === region_tag) ?? { tag: region_tag };
	core.view.selectedCDNRegion = region;

	core.view.availableRemoteBuilds = null;
	await wait_idle();
	await modules.source_select.methods.click_source_remote.call(module_ctx());

	const builds = core.view.availableRemoteBuilds;
	if (!builds)
		throw new ApiError(502, 'Unable to connect to the ' + region_tag + ' CDN.');

	return finish_casc_load(builds, body);
};

const load_mpq = async (body) => {
	assert_no_source();
	if (!body.path)
		throw new ApiError(400, 'Expected "path" to a legacy (MPQ) client directory.');

	await modules.source_select.methods.open_legacy_install.call(module_ctx(), body.path);
	await wait_idle('MPQ load');

	if (install_type_name() !== 'mpq')
		throw new ApiError(400, 'Failed to load MPQ installation at ' + body.path + '; see the runtime log.');

	return { loaded: true, status: status() };
};

// --- queries -----------------------------------------------------------------

const status = () => {
	const type = install_type_name();
	const out = {
		api_version: API_VERSION,
		app_version: nw.App.manifest.version,
		source: type,
		busy: core.view.isBusy > 0,
		loading: core.view.isLoading ? core.view.loadingTitle : null,
		active_module: core.view.activeModule?.__name ?? null,
		export_directory: core.view.config.exportDirectory,
		formats: {
			models: core.view.config.exportModelFormat,
			legacy_models: core.view.config.exportLegacyModelFormat,
			textures: core.view.config.exportTextureFormat
		}
	};

	if (type === 'casc') {
		const casc = core.view.casc;
		out.casc = {
			product: casc.build?.Product,
			build: casc.getBuildName?.(),
			remote: !!casc.region,
			region: casc.region ?? null,
			listfile_loaded: listfile.isLoaded()
		};
	} else if (type === 'mpq') {
		out.mpq = {
			directory: core.view.mpq.directory,
			archives: core.view.mpq.getArchiveCount(),
			files: core.view.mpq.getFileCount()
		};
	}

	return out;
};

const search_files = (query) => {
	const type = require_source();
	const limit = Math.min(Number(query.limit ?? 200), 5000);
	const offset = Number(query.offset ?? 0);
	const exts = query.ext ? query.ext.toLowerCase().split(',').map(e => e.startsWith('.') ? e : '.' + e) : null;

	let matcher;
	if (query.regex) {
		try {
			matcher = new RegExp(query.regex, 'i');
		} catch (e) {
			throw new ApiError(400, 'Invalid regex: ' + e.message);
		}
	} else {
		const needle = (query.q ?? '').toLowerCase().replace(/\\/g, '/');
		matcher = { test: s => s.includes(needle) };
	}

	const ext_ok = name => !exts || exts.some(e => name.endsWith(e));
	const results = [];
	let total = 0;

	if (type === 'mpq') {
		for (const [key, entry] of mpq_entries()) {
			const name = to_posix_game_path(key);
			if (!ext_ok(name) || !matcher.test(name))
				continue;

			if (total >= offset && results.length < limit)
				results.push({ file: to_posix_game_path(entry.original_filename ?? key), archive: entry.mpq_name });
			total++;
		}
	} else {
		if (!listfile.isLoaded())
			throw new ApiError(409, 'Listfile is not loaded yet.');

		// listfile names are lowercase posix paths; getFilteredEntries does substring or regex matching
		const search = matcher instanceof RegExp ? matcher : (query.q ?? '').toLowerCase().replace(/\\/g, '/');
		for (const { fileDataID, fileName } of listfile.getFilteredEntries(search)) {
			if (!ext_ok(fileName))
				continue;

			if (total >= offset && results.length < limit)
				results.push({ file: fileName, fileDataID });
			total++;
		}
	}

	return { total, offset, count: results.length, results };
};

// --- exports -----------------------------------------------------------------

const export_raw = async (body) => {
	require_source();
	const files = require_files(body);

	return with_config({ exportDirectory: body.export_dir }, async () => {
		const out_dir = core.view.config.exportDirectory;
		const succeeded = [];
		const failed = [];

		for (const input of files) {
			try {
				const { file_name, file_data_id, data } = await read_file(input);
				const out_file = path.join(out_dir, to_posix_game_path(file_name));
				await fsp.mkdir(path.dirname(out_file), { recursive: true });
				await data.writeToFile(out_file);
				succeeded.push({ source: file_name, fileDataID: file_data_id, file: out_file });
			} catch (e) {
				failed.push({ source: String(input), error: e.message });
			}
		}

		return { type: 'RAW', succeeded, failed };
	});
};

const TEXTURE_FORMATS = ['PNG', 'WEBP', 'BLP'];
const export_textures = async (body) => {
	const type = require_source();
	const files = require_files(body).map(f => type === 'casc' && /^\d+$/.test(String(f)) ? Number(f) : (type === 'mpq' ? to_posix_game_path(String(f)) : f));
	const format = body.format?.toUpperCase();
	if (format && !TEXTURE_FORMATS.includes(format))
		throw new ApiError(400, 'Texture format must be one of ' + TEXTURE_FORMATS.join(', '));

	await wait_idle();
	return with_config({ exportDirectory: body.export_dir, exportTextureFormat: format }, () =>
		textureExporter.exportFiles(files, false, -1, type === 'mpq'));
};

const MODEL_FORMATS = { casc: ['OBJ', 'GLTF', 'GLB', 'STL', 'RAW'], mpq: ['OBJ', 'STL', 'RAW'] };
const export_models = async (body) => {
	const type = require_source();
	const format = body.format?.toUpperCase();
	if (format && !MODEL_FORMATS[type].includes(format))
		throw new ApiError(400, `Model format for ${type} must be one of ${MODEL_FORMATS[type].join(', ')}`);

	const files = require_files(body);
	await wait_idle();

	if (type === 'mpq') {
		const mpq_files = files.map(f => to_posix_game_path(String(f)));
		return with_config({ exportDirectory: body.export_dir, exportLegacyModelFormat: format }, () =>
			modules.tab_models_legacy.api.export_files(core, mpq_files));
	}

	const casc_files = files.map(f => resolve_casc_file(f).file_data_id);
	return with_config({ exportDirectory: body.export_dir, exportModelFormat: format }, () =>
		modules.tab_models.api.export_files(core, casc_files, false));
};

// --- previews ----------------------------------------------------------------

const preview_texture = async (body) => {
	require_source();
	if (body.file === undefined)
		throw new ApiError(400, 'Expected "file".');

	const { file_name, data } = await read_file(body.file);
	const ext = path.extname(file_name).toLowerCase();

	if (ext === '.png' || ext === '.jpg') {
		return { file: file_name, mime: ext === '.png' ? 'image/png' : 'image/jpeg', base64: data.toBase64() };
	}

	if (ext !== '.blp')
		throw new ApiError(400, 'Not a texture file: ' + file_name);

	const blp = new BLPFile(data);
	const max_size = Number(body.max_size ?? 1024);
	let mip = 0;
	while (mip < blp.mapCount - 1 && Math.max(blp.width >> mip, blp.height >> mip) > max_size)
		mip++;

	const png = blp.toPNG(body.alpha === false ? 0b0111 : 0b1111, mip);
	return {
		file: file_name,
		mime: 'image/png',
		width: blp.width,
		height: blp.height,
		preview_width: Math.max(1, blp.width >> mip),
		preview_height: Math.max(1, blp.height >> mip),
		encoding: blp.encoding,
		alpha_depth: blp.alphaDepth,
		base64: png.toBase64()
	};
};

const preview_model = async (body) => {
	const type = require_source();
	if (body.file === undefined)
		throw new ApiError(400, 'Expected "file".');

	const is_mpq = type === 'mpq';
	const module_name = is_mpq ? 'tab_models_legacy' : 'tab_models';
	const container_id = is_mpq ? 'legacy-model-preview' : 'model-preview';
	const ctx_key = is_mpq ? 'legacyModelViewerContext' : 'modelViewerContext';
	const file_name = is_mpq ? to_posix_game_path(String(body.file)) : resolve_casc_file(body.file).file_name;

	await wait_idle();
	if (core.view.activeModule?.__name !== module_name)
		modules[module_name].setActive();

	const get_canvas = () => document.getElementById(container_id)?.querySelector('canvas');
	await wait_until(() => get_canvas() && core.view[ctx_key]?.gl_context && core.view.isBusy === 0 && !core.view.isLoading, 'model viewer to initialize');

	await modules[module_name].api.preview_model(core, file_name);
	await wait_idle('model preview');

	// give the render loop a few frames to draw with fitted camera and textures
	for (let i = 0; i < 6; i++)
		await next_frame();

	const canvas = get_canvas();
	const buf = await BufferWrapper.fromCanvas(canvas, 'image/png');

	const toast = core.view.toast;
	if (toast?.type === 'error')
		throw new ApiError(500, 'Preview failed: ' + toast.message);

	return { file: file_name, mime: 'image/png', width: canvas.width, height: canvas.height, base64: buf.toBase64() };
};

// --- routing -----------------------------------------------------------------

const CONFIG_WRITABLE = new Set([
	'exportDirectory', 'exportModelFormat', 'exportLegacyModelFormat', 'exportTextureFormat',
	'overwriteFiles', 'exportBLPMeta', 'removePathSpaces', 'exportNamedFiles'
]);

const ROUTES = {
	'GET /status': () => status(),
	'GET /sources/recent': () => ({
		casc_local: core.view.config.recentLocal ?? [],
		mpq: core.view.config.recentLegacy ?? [],
		cdn_regions: core.view.cdnRegions.map(r => ({ tag: r.tag, delay: r.delay ?? null })),
		products: constants.PRODUCTS.map(p => ({ product: p.product, title: p.title }))
	}),
	'POST /source/casc-local': ({ body }) => enqueue(() => load_casc_local(body)),
	'POST /source/casc-remote': ({ body }) => enqueue(() => load_casc_remote(body)),
	'POST /source/mpq': ({ body }) => enqueue(() => load_mpq(body)),
	'POST /app/restart': () => {
		setTimeout(() => chrome.runtime.reload(), 100);
		return { restarting: true };
	},
	'GET /files/search': ({ query }) => search_files(query),
	'POST /export/raw': ({ body }) => enqueue(() => export_raw(body)),
	'POST /export/textures': ({ body }) => enqueue(() => export_textures(body)),
	'POST /export/models': ({ body }) => enqueue(() => export_models(body)),
	'POST /preview/texture': ({ body }) => enqueue(() => preview_texture(body)),
	'POST /preview/model': ({ body }) => enqueue(() => preview_model(body)),
	'GET /config': () => Object.fromEntries([...CONFIG_WRITABLE].map(k => [k, core.view.config[k]])),
	'POST /config': ({ body }) => {
		for (const [key, value] of Object.entries(body)) {
			if (!CONFIG_WRITABLE.has(key))
				throw new ApiError(400, 'Config key not writable via API: ' + key);
			core.view.config[key] = value;
		}
		return Object.fromEntries([...CONFIG_WRITABLE].map(k => [k, core.view.config[k]]));
	}
};

const send = (res, status_code, payload) => {
	const json = JSON.stringify(payload);
	res.writeHead(status_code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
	res.end(json);
};

const handle = async (req, res, port) => {
	// block browser-originated requests (CSRF / DNS rebinding); local tools never send Origin
	const host = (req.headers.host ?? '').toLowerCase();
	if (req.headers.origin || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`))
		return send(res, 403, { error: 'Forbidden' });

	const url = new URL(req.url, `http://127.0.0.1:${port}`);
	const route = ROUTES[`${req.method} ${url.pathname}`];
	if (!route)
		return send(res, 404, { error: 'Unknown endpoint ' + req.method + ' ' + url.pathname, endpoints: Object.keys(ROUTES) });

	try {
		const body = req.method === 'POST' ? await read_body(req) : {};
		const result = await route({ body, query: parse_query(url) });
		send(res, 200, result ?? {});
	} catch (e) {
		const code = e instanceof ApiError ? e.status : 500;
		if (code === 500)
			log.write('api: %s %s failed: %o', req.method, url.pathname, e);
		send(res, code, { error: e.message });
	}
};

let server = null;

const start = () => {
	const config = core.view.config;
	if (config.apiServerEnabled === false) {
		log.write('api: disabled by config');
		return;
	}

	const port = Number(config.apiServerPort) || 17753;
	server = http.createServer((req, res) => handle(req, res, port));
	server.on('error', e => log.write('api: server error: %s', e.message));
	server.listen(port, '127.0.0.1', () => log.write('api: listening on http://127.0.0.1:%d', port));

	// release the port when the window reloads (restart) or closes
	window.addEventListener('beforeunload', () => server?.close());
};

module.exports = { start };
