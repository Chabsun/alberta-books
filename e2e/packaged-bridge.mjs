/**
 * Checks the packaged app (e.g. dist/win-unpacked/AlbertaBooks.exe) enters
 * the Claude Desktop bridge mode with --mcp-stdio: no window, no database,
 * a clear message on stderr and exit code 2 when the token is missing.
 *
 *   node e2e/packaged-bridge.mjs <path to AlbertaBooks.exe>
 */
import { spawn } from 'node:child_process'

const exe = process.argv[2]
if (!exe) throw new Error('Pass the path to the packaged executable.')
const child = spawn(exe, [...process.argv.slice(3), '--mcp-stdio'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ALBERTA_BOOKS_TOKEN: '' } })
let out = ''
let err = ''
child.stdout.on('data', (c) => (out += c))
child.stderr.on('data', (c) => (err += c))
child.stdin.end()
const timer = setTimeout(() => {
  child.kill()
  console.error('Timed out: the app did not exit in bridge mode.')
  process.exit(1)
}, 60_000)
const code = await new Promise((r) => child.on('exit', r))
clearTimeout(timer)
if (code !== 2 || !err.includes('ALBERTA_BOOKS_TOKEN') || out.trim() !== '') {
  console.error(`Unexpected result: exit ${code}\nstdout: ${out}\nstderr: ${err}`)
  process.exit(1)
}
console.log('OK: packaged app runs as the Claude Desktop bridge and writes nothing to stdout.')
