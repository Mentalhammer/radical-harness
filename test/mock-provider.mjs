import { createServer } from 'node:http';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/** The final usage block OpenAI-compatible providers send when asked. */
function emitUsage(res, prompt = 111, completion = 22) {
  sse(res, {
    choices: [],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  });
}

/** Writes one SSE line in two TCP writes to exercise client-side buffering. */
async function sseSplit(res, payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  const cut = Math.floor(line.length / 2);
  res.write(line.slice(0, cut));
  await delay(10);
  res.write(line.slice(cut));
}

export async function emitToolCall(res, name, args, withUsage = true) {
  const json = JSON.stringify(args);
  const mid = Math.max(1, Math.floor(name.length / 2));
  await sseSplit(res, { choices: [{ delta: { role: 'assistant', content: '' } }] });
  sse(res, {
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: 'call_1', type: 'function', function: { name: name.slice(0, mid), arguments: '' } },
          ],
        },
      },
    ],
  });
  sse(res, {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, function: { name: name.slice(mid), arguments: json.slice(0, 5) } }],
        },
      },
    ],
  });
  await delay(5);
  sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: json.slice(5) } }] } }] });
  sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  if (withUsage) emitUsage(res);
  res.write('data: [DONE]\n\n');
  res.end();
}

/** Some servers repeat the full tool name on every chunk instead of splitting it. */
async function emitRepeatedNameCall(res, name, args) {
  const json = JSON.stringify(args);
  sse(res, {
    choices: [
      { delta: { tool_calls: [{ index: 0, id: 'call_repeat', type: 'function', function: { name, arguments: '' } }] } },
    ],
  });
  sse(res, {
    choices: [
      {
        delta: {
          tool_calls: [{ index: 0, function: { name, arguments: json } }],
        },
      },
    ],
  });
  sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
  emitUsage(res);
  res.write('data: [DONE]\n\n');
  res.end();
}

export function emitText(res, text, withUsage = true) {
  sse(res, { choices: [{ delta: { content: text.slice(0, 6) } }] });
  sse(res, { choices: [{ delta: { content: text.slice(6) } }] });
  sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }] });
  if (withUsage) emitUsage(res);
  res.write('data: [DONE]\n\n');
  res.end();
}

async function collect(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw);
}

/**
 * Scripted provider:
 *  - "attachment-test" prompts report whether image and text parts arrived
 *  - "read-mode-test" prompts attempt an edit and a destructive command
 *  - "delete-file" prompts ask for a destructive bash command
 *  - everything else runs read_file → edit_file → bash(cat) → final text
 */
export function createMockProvider() {
  let flakyRequests = 0;
  let loopSteps = 0;
  const server = createServer(async (req, res) => {
    if (!req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let body;
    try {
      body = await collect(req);
    } catch {
      res.writeHead(400).end();
      return;
    }

    // "mock-hang" never answers; "mock-stall" sends a stream that stops after
    // the first chunk. Both exercise the client's timeouts.
    if (body.model === 'mock-hang') {
      return;
    }
    if (body.model === 'mock-stall') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
      return;
    }
    if (body.model === 'mock-flood') {
      // No newline means no frame: the client must cap its buffer instead of
      // growing it until the process dies.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: ' + 'x'.repeat(2_100_000));
      res.end();
      return;
    }

    // "mock-fail" is a fatal error: the turn must end instead of retrying, and the
    // prompt it carried must not survive in the transcript.
    if (body.model === 'mock-fail') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'mock-fail: the model refused this request' } }));
      return;
    }

    // "mock-flaky" fails the first request with a retryable status.
    if (body.model === 'mock-flaky') {
      flakyRequests += 1;
      if (flakyRequests === 1) {
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' });
        res.end(JSON.stringify({ error: { message: 'temporarily unavailable' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      emitText(res, 'Recovered after retry.', body.model !== 'mock-no-usage');
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    // "mock-no-usage" imitates servers that never report token counts, so the
    // harness falls back to its own estimate.
    const withUsage = body.model !== 'mock-no-usage';

    const messages = body.messages ?? [];
    const lastUserIndex = messages.map((message) => message.role).lastIndexOf('user');
    const lastUserContent = messages[lastUserIndex]?.content ?? '';
    const lastUser = Array.isArray(lastUserContent)
      ? lastUserContent
          .filter((part) => part?.type === 'text')
          .map((part) => part.text)
          .join('\n')
      : String(lastUserContent);
    const toolResults = messages.slice(lastUserIndex + 1).filter((message) => message.role === 'tool');
    const lastTool = toolResults[toolResults.length - 1];    if (body.model === 'mock-messy') {
      // Comments, a corrupt frame, and CRLF endings must not derail the parser.
      res.write(': keepalive\n\n');
      res.write('data: {broken json\n\n');
      res.write('data: {"choices":[{"delta":{"content":"Messy "}}]}\r\n\r\n');
      res.write('data: {"choices":[{"delta":{"content":"but fine."},"finish_reason":"stop"}]}\n\n');
      emitUsage(res);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (body.model === 'mock-repeat-name') {
      if (toolResults.length === 0) await emitRepeatedNameCall(res, 'read_file', { path: 'hello.txt' });
      else emitText(res, 'Repeated name ok.');
      return;
    }

    if (lastUser.includes('attachment-test')) {
      const hasImage = Array.isArray(lastUserContent) && lastUserContent.some((part) => part?.type === 'image_url');
      const hasText = lastUser.includes('ATTACHMENT_SENTINEL');
      emitText(res, `attachment image=${hasImage} text=${hasText}`, withUsage);
      return;
    }

    // "loop-test" asks for a read forever, so only the step cap stops it. The
    // offset advances so the agent's identical-call guard is not what ends it.
    if (lastUser.includes('loop-test')) {
      loopSteps += 1;
      await emitToolCall(res, 'read_file', { path: 'hello.txt', offset: loopSteps }, withUsage);
      return;
    }

    if (lastUser.includes('read-mode-test')) {
      if (!lastTool) {
        await emitToolCall(
          res,
          'edit_file',
          { path: 'hello.txt', old_string: 'alpha', new_string: 'hacked' },
          withUsage,
        );
      } else if (toolResults.length === 1) {
        await emitToolCall(res, 'bash', { command: 'rm hello.txt' }, withUsage);
      } else {
        emitText(res, `Read mode result: ${lastTool?.content.slice(0, 120)}`, withUsage);
      }
      return;
    }

    if (lastUser.includes('json-read-test')) {
      if (!lastTool) {
        await emitToolCall(res, 'read_file', { path: 'big.json' }, withUsage);
      } else if (toolResults.length === 1) {
        // The model needs exact lines to edit, so it asks for the text form.
        await emitToolCall(res, 'read_file', { path: 'big.json', format: 'text' }, withUsage);
      } else {
        const compact = toolResults[0]?.content ?? '';
        const raw = toolResults[1]?.content ?? '';
        emitText(
          res,
          `Json read toon=${compact.includes('TOON')} hint=${compact.includes('format "text"')} raw=${/^\s*1\| /m.test(raw)}`,
          withUsage,
        );
      }
      return;
    }

    if (lastUser.includes('toon-test')) {
      if (!lastTool) {
        await emitToolCall(res, 'toon', { path: 'forecast.json' }, withUsage);
      } else {
        emitText(res, `Toon result: ${lastTool.content.slice(0, 200)}`, withUsage);
      }
      return;
    }

    if (lastUser.includes('schema-test')) {
      if (!lastTool) {
        await emitToolCall(res, 'validate_json', { schema: 'level.schema.json', path: 'level.json' }, withUsage);
      } else {
        emitText(res, `Schema result: ${lastTool.content.slice(0, 200)}`, withUsage);
      }
      return;
    }

    const steerIndex = messages.map((message) => typeof message.content === 'string' && message.content.includes('steer-test')).lastIndexOf(true);
    if (steerIndex >= 0 && (lastUser.includes('steer-test') || lastUser.trim() === 'go left')) {
      const toolAfterSteer = messages.slice(steerIndex + 1).some((message) => message.role === 'tool');
      if (!toolAfterSteer) {
        // An approval prompt leaves the turn open long enough to steer it.
        await emitToolCall(res, 'bash', { command: 'rm hello.txt' }, withUsage);
      } else {
        emitText(res, `Steered: ${lastUser}`, withUsage);
      }
      return;
    }

    if (lastUser.includes('system-danger')) {
      if (!lastTool) {
        await emitToolCall(res, 'bash', { command: 'format C:' }, withUsage);
      } else {
        emitText(res, `Blocked: ${lastTool.content.slice(0, 160)}`, withUsage);
      }
      return;
    }

    if (lastUser.includes('invalid-json-test')) {
      if (!lastTool) {
        await emitToolCall(res, 'validate_json', { schema: 'level.schema.json', path: 'broken.json' }, withUsage);
      } else {
        emitText(res, `Schema result: ${lastTool.content.slice(0, 300)}`, withUsage);
      }
      return;
    }

    if (lastUser.includes('question-test')) {
      if (!lastTool) {
        await emitToolCall(
          res,
          'ask_user',
          { question: 'Which branch should I change?', options: ['main', 'feature'] },
          withUsage,
        );
      } else {
        emitText(res, `Question result: ${lastTool.content.slice(0, 160)}`, withUsage);
      }
      return;
    }

    // "secret-test" proves credentials in tool output never reach the model.
    if (lastUser.includes('secret-test')) {
      if (!lastTool) await emitToolCall(res, 'bash', { command: 'cat secret.txt' }, withUsage);
      else emitText(res, `Secret result: ${lastTool.content}`, withUsage);
      return;
    }

    if (lastUser.includes('delete-file')) {
      if (!lastTool) {
        await emitToolCall(res, 'bash', { command: 'rm hello.txt' }, withUsage);
      } else {
        emitText(res, `Blocked as expected: ${lastTool.content.slice(0, 120)}`, withUsage);
      }
      return;
    }

    if (toolResults.length === 0) {
      await emitToolCall(res, 'read_file', { path: 'hello.txt' }, withUsage);
      return;
    }
    if (toolResults.length === 1) {
      await emitToolCall(
        res,
        'edit_file',
        { path: 'hello.txt', old_string: 'beta', new_string: 'beta\ngamma' },
        withUsage,
      );
      return;
    }
    if (toolResults.length === 2) {
      await emitToolCall(res, 'bash', { command: 'cat hello.txt' }, withUsage);
      return;
    }
    emitText(res, `All good. Last tool output:\n${lastTool?.content ?? ''}`, withUsage);
  });

  return new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      ready({ server, port: address.port });
    });
  });
}
