/**
 * Checks the Claude Desktop bridge shipped in the installer
 * (dist/win-unpacked/resources/alberta-books-mcp.exe) runs as a console
 * program: a clear message on stderr, nothing on stdout, and exit code 2 when
 * the key is missing.
 *
 *   node e2e/packaged-bridge.mjs <path to alberta-books-mcp.exe>
 */
import { spawn } from 'node:child_process'

const exe = process.argv[2]
if (!exe) throw new Error('Pass the path to the packaged executable.')
const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ALBERTA_BOOKS_TOKEN: '' } })
let out = ''
let err = ''
child.stdout.on('data', (c) => (out += c))
child.stderr.on('data', (c) => (err += c))
child.stdin.end()
const timer = setTimeout(() => {
  child.kill()
  console.error('Timed out: the bridge did not exit.')
  process.exit(1)
}, 60_000)
const code = await new Promise((r) => child.on('exit', r))
clearTimeout(timer)
if (code !== 2 || !err.includes('ALBERTA_BOOKS_TOKEN') || out.trim() !== '') {
  console.error(`Unexpected result: exit ${code}\nstdout: ${out}\nstderr: ${err}`)
  process.exit(1)
}
console.log('OK: the packaged Claude Desktop bridge runs and writes nothing to stdout.')
