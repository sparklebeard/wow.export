#!/usr/bin/env node
// MCP bridge for the wow.export local HTTP API (src/js/api-server.js).
// Talks to http://127.0.0.1:<WOW_EXPORT_API_PORT|17753>; launches the app if it isn't running.
import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PORT = Number(process.env.WOW_EXPORT_API_PORT ?? 17753);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_APP = {
	darwin: process.arch === 'arm64' ? '../bin/osx-arm64/wow.export.app' : '../bin/osx-x64/wow.export.app',
	win32: '../bin/win-x64/wow.export.exe',
	linux: '../bin/linux-x64/wow.export',
}[process.platform];
const APP_PATH = process.env.WOW_EXPORT_APP ?? (DEFAULT_APP && path.resolve(HERE, DEFAULT_APP));

const request = (method, route, body) => new Promise((resolve, reject) => {
	const payload = body === undefined ? null : JSON.stringify(body);
	const req = http.request({
		host: '127.0.0.1', port: PORT, method, path: route,
		headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
	}, res => {
		const chunks = [];
		res.on('data', c => chunks.push(c));
		res.on('end', () => {
			let json;
			try {
				json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			} catch {
				return reject(new Error(`Invalid response from wow.export (${res.statusCode})`));
			}
			if (res.statusCode >= 400)
				return reject(new Error(json.error ?? `HTTP ${res.statusCode}`));
			resolve(json);
		});
	});
	// no timeout: CASC loads and large exports can legitimately take minutes
	req.on('error', reject);
	if (payload)
		req.write(payload);
	req.end();
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

let launch_attempted = false;
const call = async (method, route, body) => {
	try {
		return await request(method, route, body);
	} catch (e) {
		if (e.code !== 'ECONNREFUSED')
			throw e;

		if (launch_attempted || !APP_PATH || !existsSync(APP_PATH))
			throw new Error(`wow.export is not running (no API on 127.0.0.1:${PORT}). Launch the app and try again.`);

		launch_attempted = true;
		if (process.platform === 'darwin')
			spawn('open', [APP_PATH], { detached: true, stdio: 'ignore' }).unref();
		else
			spawn(APP_PATH, [], { detached: true, stdio: 'ignore', cwd: path.dirname(APP_PATH) }).unref();
		for (let i = 0; i < 60; i++) {
			await sleep(1000);
			try {
				await request('GET', '/status');
				return await request(method, route, body);
			} catch (err) {
				if (err.code !== 'ECONNREFUSED')
					throw err;
			}
		}
		throw new Error('Launched wow.export but its API did not come up within 60s.');
	}
};

const text = obj => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });

const tool = (handler) => async (args) => {
	try {
		return await handler(args);
	} catch (e) {
		return { isError: true, content: [{ type: 'text', text: e.message }] };
	}
};

const image_result = (res) => {
	const { base64, mime, ...meta } = res;
	return { content: [{ type: 'image', data: base64, mimeType: mime }, { type: 'text', text: JSON.stringify(meta) }] };
};

const server = new McpServer({ name: 'wow-export', version: '1.0.0' }, {
	instructions: [
		'Drives a running wow.export app (World of Warcraft asset exporter).',
		'Typical flow: wowexport_status -> wowexport_load_source (once per app session) -> wowexport_search -> wowexport_preview_* -> wowexport_export.',
		'Only one source can be loaded per session; call wowexport_restart before switching sources.',
		'CASC (retail/classic) files can be referenced by listfile path or fileDataID; MPQ (legacy, e.g. 3.3.5) files by game path like "World/Generic/.../foo.m2".',
		'Legacy WotLK (3.3.5) M2 models cannot be previewed or converted (raw export works); WMOs, textures and older M2s are fine.'
	].join(' ')
});

const file_ref = z.union([z.string(), z.number()]);

server.registerTool('wowexport_status', {
	description: 'Get wow.export status: loaded source (casc/mpq/none), build, busy state, export directory and default formats.',
	annotations: { readOnlyHint: true }
}, tool(async () => text(await call('GET', '/status'))));

server.registerTool('wowexport_list_sources', {
	description: 'List recently used local CASC installs and MPQ (legacy) clients, CDN regions, and known CASC product codes.',
	annotations: { readOnlyHint: true }
}, tool(async () => text(await call('GET', '/sources/recent'))));

server.registerTool('wowexport_load_source', {
	description: 'Load a game source. casc_local = local retail/classic install directory; casc_remote = Blizzard CDN; mpq = legacy client directory (e.g. 3.3.5). For CASC, omit product/build_index to get the list of available builds first. Can take several minutes on first load.',
	inputSchema: {
		type: z.enum(['casc_local', 'casc_remote', 'mpq']),
		path: z.string().optional().describe('Install directory (casc_local, mpq)'),
		product: z.string().optional().describe('CASC product code, e.g. wow, wow_classic, wow_classic_era, wowt'),
		build_index: z.number().int().optional().describe('buildIndex from a previous build listing'),
		region: z.string().optional().describe('CDN region for casc_remote: us, eu, kr, tw, cn')
	}
}, tool(async ({ type, ...body }) => text(await call('POST', '/source/' + type.replace('_', '-'), body))));

server.registerTool('wowexport_restart', {
	description: 'Restart wow.export (unloads the current source). Needed before loading a different source. Interrupts anything the user is doing in the app.',
	annotations: { destructiveHint: true }
}, tool(async () => {
	await call('POST', '/app/restart');
	for (let i = 0; i < 60; i++) {
		await sleep(1000);
		try {
			const status = await request('GET', '/status');
			if (status.source === 'none')
				return text({ restarted: true, status });
		} catch {}
	}
	throw new Error('wow.export did not come back within 60s after restart.');
}));

server.registerTool('wowexport_search', {
	description: 'Search files in the loaded source by substring or regex, optionally filtered by extension(s). Returns paths (and fileDataIDs for CASC).',
	inputSchema: {
		query: z.string().optional().describe('Case-insensitive substring of the path'),
		regex: z.string().optional().describe('Case-insensitive regex instead of query'),
		ext: z.string().optional().describe('Comma-separated extensions, e.g. "m2,wmo" or "blp"'),
		limit: z.number().int().min(1).max(5000).optional(),
		offset: z.number().int().min(0).optional()
	},
	annotations: { readOnlyHint: true }
}, tool(async ({ query, regex, ext, limit, offset }) => {
	const qs = new URLSearchParams();
	if (query) qs.set('q', query);
	if (regex) qs.set('regex', regex);
	if (ext) qs.set('ext', ext);
	if (limit) qs.set('limit', String(limit));
	if (offset) qs.set('offset', String(offset));
	return text(await call('GET', '/files/search?' + qs));
}));

server.registerTool('wowexport_export', {
	description: [
		'Export files to disk. kind=raw writes the original game files unchanged (preserving game paths);',
		'kind=textures converts BLP (format PNG, WEBP or BLP);',
		'kind=models converts M2/WMO (CASC: OBJ, GLTF, GLB, STL, RAW; MPQ: OBJ, STL, RAW) including their textures.',
		'Returns a manifest of written files and per-file errors.'
	].join(' '),
	inputSchema: {
		kind: z.enum(['raw', 'textures', 'models']),
		files: z.array(file_ref).min(1).describe('Paths (or CASC fileDataIDs)'),
		format: z.string().optional().describe('Overrides the app default format for this export'),
		export_dir: z.string().optional().describe('Absolute output directory; defaults to the app export directory')
	}
}, tool(async ({ kind, ...body }) => text(await call('POST', '/export/' + kind, body))));

server.registerTool('wowexport_preview_texture', {
	description: 'Render a BLP/PNG/JPG texture from the loaded source and return it as an image.',
	inputSchema: {
		file: file_ref,
		max_size: z.number().int().min(16).max(4096).optional().describe('Largest dimension; picks a mipmap (default 1024)'),
		alpha: z.boolean().optional().describe('false to drop the alpha channel')
	},
	annotations: { readOnlyHint: true }
}, tool(async (body) => image_result(await call('POST', '/preview/texture', body))));

server.registerTool('wowexport_preview_model', {
	description: 'Render an M2/WMO model in the wow.export 3D viewer and return a screenshot. Switches the app to its Models tab.',
	inputSchema: { file: file_ref },
	annotations: { readOnlyHint: true }
}, tool(async (body) => image_result(await call('POST', '/preview/model', body))));

server.registerTool('wowexport_config', {
	description: 'Read export settings, or update them by passing "set" (keys: exportDirectory, exportModelFormat, exportLegacyModelFormat, exportTextureFormat, overwriteFiles, exportBLPMeta, removePathSpaces, exportNamedFiles). Changes persist in the app.',
	inputSchema: { set: z.record(z.string(), z.any()).optional() }
}, tool(async ({ set }) => text(set ? await call('POST', '/config', set) : await call('GET', '/config'))));

server.registerTool('wowexport_search_items', {
	description: 'Search equippable items (CASC) by name. slot filters by equipment slot id (1 head, 3 shoulder, 5 chest, 6 waist, 7 legs, 8 feet, 9 wrist, 10 hands, 15 back, 16 main-hand, 17 off-hand, 19 tabard, 4 shirt). Returns item ids for wowexport_load_character.',
	inputSchema: {
		query: z.string().optional().describe('Case-insensitive substring of the item name'),
		slot: z.number().int().optional(),
		min_quality: z.number().int().min(0).max(7).optional().describe('0 poor .. 4 epic, 5 legendary'),
		limit: z.number().int().min(1).max(1000).optional()
	},
	annotations: { readOnlyHint: true }
}, tool(async ({ query, slot, min_quality, limit }) => {
	const qs = new URLSearchParams();
	if (query) qs.set('q', query);
	if (slot !== undefined) qs.set('slot', String(slot));
	if (min_quality !== undefined) qs.set('min_quality', String(min_quality));
	if (limit) qs.set('limit', String(limit));
	return text(await call('GET', '/items/search?' + qs));
}));

server.registerTool('wowexport_load_character', {
	description: [
		'Load a character into the Characters tab and return a screenshot of the viewer.',
		'Pass "character" as a saved-character object (the ~/wow.export/My Characters JSON format: version 2, race_id, model_id, choices [{optionID, choiceID}], equipment {slotID: itemID}),',
		'or "file" as a path to such a JSON. Waits until the model and all equipment have loaded.'
	].join(' '),
	inputSchema: {
		character: z.record(z.string(), z.any()).optional(),
		file: z.string().optional(),
		screenshot: z.boolean().optional()
	}
}, tool(async (body) => {
	const res = await call('POST', '/character/load', body);
	if (!res.preview)
		return text(res);
	const { preview, ...rest } = res;
	return { content: [{ type: 'image', data: preview.base64, mimeType: preview.mime }, { type: 'text', text: JSON.stringify(rest) }] };
}));

server.registerTool('wowexport_character_options', {
	description: 'List the customization options (skin, face, hair style, hair color, beard, ...) of the character model currently loaded in the Characters tab, with every choice id/label and the active choice. Use with wowexport_load_character "choices".',
	inputSchema: {},
	annotations: { readOnlyHint: true }
}, tool(async () => text(await call('GET', '/character/options'))));

server.registerTool('wowexport_export_character', {
	description: 'Export the character currently loaded in the Characters tab as glTF (with its equipment). Returns the written .gltf path.',
	inputSchema: {
		export_dir: z.string().optional().describe('Absolute output directory; defaults to the app export directory'),
		animations: z.boolean().optional().describe('Include animations (large: hundreds of clips)')
	}
}, tool(async (body) => text(await call('POST', '/character/export', body))));

await server.connect(new StdioServerTransport());
