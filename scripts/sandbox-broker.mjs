#!/usr/bin/env node
/**
 * R69 local sandbox broker CLI.
 *
 * `serve` starts the host-local Unix-socket service. Other commands are thin
 * clients; none accepts raw Docker arguments or arbitrary host paths.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SandboxBrokerService, createDockerCliRuntime, defaultMainActorId, defaultBrokerRegistryPath } from '../lib/secretary/broker.js'
import { SandboxBrokerClient } from '../lib/secretary/broker-client.js'
import { listenBroker } from '../lib/secretary/broker-server.js'

const defaultSocket = join(homedir(), '.local', 'share', 'feishu4dsh', 'broker', 'broker.sock')

function usage() {
  return `sandbox broker

Usage:
  pnpm sandbox:broker -- serve [--socket <path>] [--registry <path>] [--main-actor-id <id>]
  pnpm sandbox:broker -- health|list
  pnpm sandbox:broker -- next-name [suffix]
  pnpm sandbox:broker -- info <name>
  pnpm sandbox:broker -- stats <name>
  pnpm sandbox:broker -- register <descriptor.json>
  pnpm sandbox:broker -- start|stop|restart|destroy <name>
  pnpm sandbox:broker -- main [actorId]
  pnpm sandbox:broker -- message --from <main|sandbox> --to <sandbox> --root-task <id> [options]

message options:
  --parent-task <id>
  --message-id <id>
  --ttl <seconds>
  --text <text> --as <relative-path>
  --file <host-file> --as <relative-path>     # inline base64; small control files only
  --from-outbox <relative-path> --as <relative-path>  # only for a sandbox sender

Common:
  --socket <path>    default: ~/.local/share/feishu4dsh/broker/broker.sock
  --registry <path>  default: ~/.local/share/feishu4dsh/broker/registry.json
`
}

function parse(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      flags[key] = value
      i += 1
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

function client(flags) {
  return new SandboxBrokerClient({ socketPath: flags.socket ?? defaultSocket })
}

async function print(value) {
  console.log(JSON.stringify(value, null, 2))
}

async function message(client, flags) {
  if (flags.from === undefined || flags.to === undefined || flags['root-task'] === undefined) {
    throw new Error('message requires --from, --to and --root-task')
  }
  const artifacts = []
  if (flags.text !== undefined) artifacts.push({ text: flags.text, path: flags.as ?? 'message.txt' })
  if (flags.file !== undefined) {
    if (flags.as === undefined) throw new Error('--file requires --as')
    artifacts.push({ base64: (await readFile(flags.file)).toString('base64'), path: flags.as })
  }
  if (flags['from-outbox'] !== undefined) {
    if (flags.as === undefined) throw new Error('--from-outbox requires --as')
    artifacts.push({ fromOutbox: flags['from-outbox'], path: flags.as })
  }
  await print(await client.sendMessage(flags.to, {
    from: flags.from,
    rootTaskId: flags['root-task'],
    ...(flags['parent-task'] === undefined ? {} : { parentTaskId: flags['parent-task'] }),
    ...(flags['message-id'] === undefined ? {} : { messageId: flags['message-id'] }),
    ...(flags.ttl === undefined ? {} : { ttlSeconds: Number(flags.ttl) }),
    artifacts,
  }))
}

async function main() {
  const parsed = parse(process.argv.slice(2))
  if (parsed.help) { console.log(usage()); return }
  const [command, ...args] = parsed.positional
  if (command === 'serve') {
    const registryPath = parsed.flags.registry ?? defaultBrokerRegistryPath()
    const socketPath = parsed.flags.socket ?? defaultSocket
    const mainActorId = parsed.flags['main-actor-id'] ?? defaultMainActorId()
    const service = new SandboxBrokerService({ registryPath, docker: createDockerCliRuntime(), mainActorId })
    await service.init()
    const server = await listenBroker(service, socketPath)
    console.log(`sandbox broker listening on ${socketPath}`)
    console.log(`registry: ${registryPath}`)
    console.log(`main actor: ${mainActorId}`)
    const stop = async () => { server.close(); process.exit(0) }
    process.on('SIGINT', () => void stop())
    process.on('SIGTERM', () => void stop())
    return
  }
  if (command === undefined) { console.log(usage()); return }
  const c = client(parsed.flags)
  if (command === 'health') return print(await c.health())
  if (command === 'list') return print(await c.list())
  if (command === 'next-name') return print(await c.nextName(args[0]))
  if (command === 'main') return print(await c.registerMain(args[0]))
  if (command === 'info' && args[0] !== undefined) return print(await c.info(args[0]))
  if (command === 'stats' && args[0] !== undefined) return print(await c.stats(args[0]))
  if (command === 'register' && args[0] !== undefined) return print(await c.register(args[0]))
  if (command === 'start' && args[0] !== undefined) return print(await c.start(args[0]))
  if (command === 'stop' && args[0] !== undefined) return print(await c.stop(args[0]))
  if (command === 'restart' && args[0] !== undefined) return print(await c.restart(args[0]))
  if (command === 'destroy' && args[0] !== undefined) return print(await c.destroy(args[0]))
  if (command === 'message') return message(c, parsed.flags)
  throw new Error(`unknown or incomplete command: ${command}\n\n${usage()}`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
