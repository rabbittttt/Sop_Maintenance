import {readFileSync} from 'node:fs';

const web = new URL('../web/', import.meta.url);
const html = readFileSync(new URL('index.html', web), 'utf8');
const scripts = [...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)];
export const dashboardSource = scripts.map(([, path]) =>
  readFileSync(new URL(path.split('?')[0], web), 'utf8')
).join('\n');
