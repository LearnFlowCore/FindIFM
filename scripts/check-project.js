// Статическая проверка проекта: синтаксис JS, package.json, ресурсы HTML и иконка.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const errors = [];
const files = [];
const skip = new Set(['node_modules', 'data', 'logs', 'exports', 'dist', '.git', '.runtime']);

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
}

for (const dir of ['src', 'public', 'test', 'scripts', 'electron']) {
  const target = path.join(root, dir);
  if (fs.existsSync(target)) walk(target);
}

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    const output = String(error.stderr || error.message).split('\n')[0];
    errors.push(`${path.relative(root, file)}: ${output}`);
  }
}

try { JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); }
catch (error) { errors.push(`package.json: ${error.message}`); }

const publicRoot = path.join(root, 'public');
for (const name of fs.readdirSync(publicRoot).filter(file => file.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(publicRoot, name), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = match[1];
    if (/^(?:https?:|data:|mailto:|#|\/)/.test(ref)) continue;
    if (!fs.existsSync(path.join(publicRoot, ref.split('?')[0]))) errors.push(`${name}: нет файла ${ref}`);
  }
}

if (!fs.existsSync(path.join(root, 'build', 'icon.ico'))) errors.push('build/icon.ico не найден');

if (errors.length) {
  console.error(`Проверка не пройдена (${errors.length}):`);
  for (const error of errors) console.error(` - ${error}`);
  process.exit(1);
}
console.log(`Проверка пройдена: ${files.length} JS-файлов, package.json, ресурсы HTML и иконка сборки.`);
