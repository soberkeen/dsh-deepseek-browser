#!/usr/bin/env node
// asar.mjs — 只读地浏览 / 抽取 Electron 的 app.asar（含 ES module 与 CJS 混装的常见形态）
//
// 为什么需要它：DSH 的插件契约（slot 名、client bundle 路由、webview 租约流程）都写在
// app.asar 里，而 asar 不是普通压缩包 —— 文件内容连续存放，靠 JSON header 里的 offset/size
// 定位。用 npx asar 也能解开，但那样会落地几百 MB；本脚本只解你点名的那几个文件。
//
// 用法：
//   node asar.mjs list    <app.asar> [prefix]            列文件（含大小），prefix 可省略
//   node asar.mjs cat     <app.asar> <path/in/asar>      把单个文件打到 stdout
//   node asar.mjs stat    <app.asar> <path/in/asar>      看单个文件的 offset/size/unpacked
//   node asar.mjs extract <app.asar> <outDir> [prefix...] 抽取匹配前缀的文件（省略 = 全部）
//
// 示例：
//   node asar.mjs list resources/app.asar node_modules/@deepseek-ai/
//   node asar.mjs cat resources/app.asar package.json
//   node asar.mjs extract resources/app.asar ./asar-out node_modules/@deepseek-ai/dsh-client-ui-slots
//
// 退出码：0 成功；1 用法错误；2 目标不存在；3 文件写入失败。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const USAGE = `用法：
  node asar.mjs list    <app.asar> [prefix]
  node asar.mjs cat     <app.asar> <path/in/asar>
  node asar.mjs stat    <app.asar> <path/in/asar>
  node asar.mjs extract <app.asar> <outDir> [prefix...]`

function die(message, code) {
  console.error(message)
  process.exit(code)
}

function openAsar(file) {
  const buf = readFileSync(file)
  const headerSize = buf.readUInt32LE(4)
  const jsonSize = buf.readUInt32LE(12)
  const header = JSON.parse(buf.toString('utf8', 16, 16 + jsonSize))
  const dataOffset = 8 + headerSize

  const files = new Map()
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files || {})) {
      const path = prefix ? `${prefix}/${name}` : name
      if (child.files) walk(child, path)
      else files.set(path, child)
    }
  }
  walk(header, '')
  return { buf, dataOffset, files }
}

function sliceOf(archive, entry) {
  if (entry.unpacked) return null
  const start = archive.dataOffset + Number(entry.offset)
  return archive.buf.subarray(start, start + Number(entry.size))
}

function normalize(path) {
  return String(path).replace(/^\/+/, '')
}

const [command, asarPath, ...rest] = process.argv.slice(2)

if (!command || !asarPath) die(USAGE, 1)

let archive
try {
  archive = openAsar(asarPath)
} catch (error) {
  die(`打不开 asar：${asarPath}\n${error.message}`, 2)
}

const { files } = archive

if (command === 'list') {
  const prefix = normalize(rest[0] || '')
  const matched = [...files.keys()].filter((path) => path.startsWith(prefix)).sort()
  const LIMIT = 5000
  for (const path of matched.slice(0, LIMIT)) {
    console.log(`${files.get(path).size}\t${path}`)
  }
  if (matched.length > LIMIT) console.log(`… 另有 ${matched.length - LIMIT} 个文件未列出`)
  console.error(`matched=${matched.length}`)
} else if (command === 'cat') {
  const path = normalize(rest[0] || '')
  const entry = files.get(path)
  if (!entry) die(`asar 里没有这个文件：${path}`, 2)
  const bytes = sliceOf(archive, entry)
  if (!bytes) die(`这个文件是 unpacked 的（内容在 app.asar.unpacked/ 下）：${path}`, 2)
  process.stdout.write(bytes)
} else if (command === 'stat') {
  const path = normalize(rest[0] || '')
  const entry = files.get(path)
  if (!entry) die(`asar 里没有这个文件：${path}`, 2)
  console.log(JSON.stringify({ path, size: entry.size, offset: entry.offset, unpacked: Boolean(entry.unpacked) }, null, 2))
} else if (command === 'extract') {
  const outDir = resolve(rest[0] || '.')
  const prefixes = rest.slice(1).map(normalize)
  const matched = [...files.entries()].filter(([path]) => (prefixes.length ? prefixes.some((prefix) => path.startsWith(prefix)) : true))
  let written = 0
  let skipped = 0
  for (const [path, entry] of matched) {
    const bytes = sliceOf(archive, entry)
    if (!bytes) {
      skipped += 1
      continue
    }
    const target = isAbsolute(path) ? join(outDir, path.replace(/^[A-Za-z]:/, '')) : join(outDir, path)
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, bytes)
    } catch (error) {
      die(`写文件失败：${target}\n${error.message}`, 3)
    }
    written += 1
  }
  console.log(`extracted=${written} skipped_unpacked=${skipped} -> ${outDir}${prefixes.length ? ` for ${prefixes.join(', ')}` : ''}`)
} else {
  die(`未知命令：${command}\n\n${USAGE}`, 1)
}
