const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', '.test-dist', 'node_modules', 'obsidian');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'commonjs', main: 'index.js' }));
fs.writeFileSync(path.join(dir, 'index.js'), `
class DataAdapter {}
class FileSystemAdapter extends DataAdapter {
  constructor(basePath = '') { super(); this.basePath = basePath; }
  getBasePath() { return this.basePath; }
}
class Modal {}
async function requestUrl(options) {
  const headers = options.headers || {};
  const init = { method: options.method || 'GET', headers, body: options.body };
  const res = await fetch(options.url, init);
  const arrayBuffer = await res.arrayBuffer();
  const text = Buffer.from(arrayBuffer).toString('utf8');
  let json = undefined;
  try { json = text ? JSON.parse(text) : undefined; } catch {}
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), arrayBuffer, text, json };
}
module.exports = { DataAdapter, FileSystemAdapter, Modal, requestUrl };
`);
