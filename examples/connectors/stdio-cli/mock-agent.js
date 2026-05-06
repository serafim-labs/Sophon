#!/usr/bin/env node

process.stdin.setEncoding('utf8')

let input = ''
process.stdin.on('data', (chunk) => {
  input += chunk
})

process.stdin.on('end', async () => {
  const message = input.trim() || '(empty message)'
  const chunks = [
    'Mock CLI agent received: ',
    message,
    '\n\nThis text is streamed from stdout back into Sophon.',
  ]

  for (const chunk of chunks) {
    process.stdout.write(chunk)
    await sleep(250)
  }
})

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
