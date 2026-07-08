// Copies static assets (node icons) into dist after tsc.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const assets = [
	'nodes/SolytiqCloud/solytiq-cloud.png',
	'nodes/SolytiqCloudTrigger/solytiq-cloud.png',
];

for (const asset of assets) {
	const target = `dist/${asset}`;
	mkdirSync(dirname(target), { recursive: true });
	copyFileSync(asset, target);
	console.log(`copied ${asset} -> ${target}`);
}
