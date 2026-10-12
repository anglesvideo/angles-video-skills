import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The starter's character script, exercised from `src/`, the copy the Skills
// are synced from.
const script = fileURLToPath(new URL('../src/starter/scripts/character.mjs', import.meta.url));
const testKey = 'character_key_that_must_not_leak';

const WHO = 'An ordinary programmer of about twenty-eight, tall, thin and slouching. Not handsome, not stylish.';
const kept = (extra = {}) => ({
  id: 'asset-1',
  name: 'dev-night',
  description: WHO,
  pictures: [{ url: 'https://cdn.test/characters/sheet.jpg', width: 1728, height: 2304 }],
  updatedAt: '2026-10-10T08:00:00.000Z',
  ...extra,
});

async function run(directory, args, env = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: directory,
    env: { ...process.env, ANGLES_API_KEY: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', chunk => (stderr += chunk));
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}

/**
 * Angles, as far as characters go, and a workspace with two pictures made in
 * it: `dev-night` (a JPEG) and `side` (a PNG). `reply(request)` decides what
 * one call gets back.
 */
async function withAngles(reply, runWith) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const seen = { method: request.method, url: request.url, headers: request.headers, form: Buffer.concat(chunks).toString('latin1') };
    requests.push(seen);
    const { status = 200, ...json } = reply(seen, requests.length);
    response.statusCode = status;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(json));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const directory = await mkdtemp(join(tmpdir(), 'angles-character-'));
  try {
    await mkdir(join(directory, 'public', 'images'), { recursive: true });
    await mkdir(join(directory, 'src'), { recursive: true });
    await writeFile(join(directory, 'public', 'images', 'dev-night.jpg'), 'the bytes of the sheet');
    await writeFile(join(directory, 'public', 'images', 'side.png'), 'the bytes of the side view');
    await writeFile(join(directory, 'loose.webp'), 'the bytes of a file of their own');
    await writeFile(
      join(directory, 'src', 'images.json'),
      JSON.stringify({ 'dev-night': { src: 'images/dev-night.jpg', generated: true }, side: { src: 'images/side.png', generated: true } })
    );
    const env = { ANGLES_API_KEY: testKey, ANGLES_API_BASE_URL: `http://127.0.0.1:${server.address().port}` };
    return await runWith({ directory, env, requests });
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const field = (form, name) => form.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`))?.[1];
const filesIn = form => [...form.matchAll(/name="files"; filename="([^"]+)"\r\nContent-Type: ([^\r]+)\r\n\r\n([^\r]*)/g)].map(([, name, type, bytes]) => ({ name, type, bytes }));

test('keeps the picture of the same name, and the words, as a character', async () => {
  await withAngles(
    () => ({ status: 201, ...kept() }),
    async ({ directory, env, requests }) => {
      const result = await run(directory, ['keep', 'dev-night', `  ${WHO}  `], env);

      assert.equal(result.code, 0, result.stderr);
      assert.equal(requests.length, 1);
      assert.equal(`${requests[0].method} ${requests[0].url}`, 'POST /characters');
      assert.equal(requests[0].headers.authorization, `Bearer ${testKey}`);
      assert.match(requests[0].headers['content-type'], /^multipart\/form-data/);
      assert.equal(field(requests[0].form, 'name'), 'dev-night');
      assert.equal(field(requests[0].form, 'description'), WHO);
      assert.deepEqual(filesIn(requests[0].form), [{ name: 'dev-night.jpg', type: 'image/jpeg', bytes: 'the bytes of the sheet' }]);
      assert.equal(
        result.stdout,
        `Kept dev-night: 1 picture, ${WHO.length} characters of words.\nAny project on this account draws them with: node scripts/image.mjs <name> "<what they are doing>" --character dev-night\n`
      );
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(testKey));
    }
  );
});

test('--from keeps other pictures instead: ones made here by name, or files, the first first', async () => {
  await withAngles(
    () => ({ status: 201, ...kept({ name: 'night-dev', pictures: [{ url: 'a' }, { url: 'b' }, { url: 'c' }] }) }),
    async ({ directory, env, requests }) => {
      const result = await run(directory, ['keep', 'night-dev', WHO, '--from', 'side, dev-night,loose.webp'], env);

      assert.equal(result.code, 0, result.stderr);
      assert.equal(field(requests[0].form, 'name'), 'night-dev');
      assert.deepEqual(
        filesIn(requests[0].form).map(file => `${file.name} ${file.type}`),
        ['side.png image/png', 'dev-night.jpg image/jpeg', 'loose.webp image/webp']
      );
      assert.match(result.stdout, /^Kept night-dev: 3 pictures,/);
    }
  );
});

test('sends nothing when what was asked could not be kept', async () => {
  await withAngles(
    () => ({ status: 201, ...kept() }),
    async ({ directory, env, requests }) => {
      const wordless = await run(directory, ['keep', 'dev-night'], env);
      assert.match(wordless.stderr, /Say who dev-night is: node scripts\/character\.mjs keep dev-night "<who they are, and what they must not be drawn as>"/);
      const spaced = await run(directory, ['keep', 'dev night', WHO], env);
      assert.match(spaced.stderr, /"dev night" cannot be a character's name/);
      const pictureless = await run(directory, ['keep', 'singer', WHO], env);
      assert.match(pictureless.stderr, /There is no picture named singer here to keep\. Say which: .* --from <picture>/);
      const missing = await run(directory, ['keep', 'singer', WHO, '--from', 'stage'], env);
      assert.match(missing.stderr, /There is no picture "stage": not one made here \(dev-night, side\), and not a file\./);
      const crowded = await run(directory, ['keep', 'singer', WHO, '--from', Array(11).fill('side').join(',')], env);
      assert.match(crowded.stderr, /A character has at most 10 pictures\./);
      const both = await run(directory, ['keep', 'dev-night', '--add', '--replace', '--from', 'side'], env);
      assert.match(both.stderr, /--add puts pictures beside the ones kept and --replace puts them in their place: use one\./);
      const addless = await run(directory, ['keep', 'dev-night', '--add'], env);
      assert.match(addless.stderr, /Say which pictures to add: node scripts\/character\.mjs keep dev-night --add --from <picture>/);
      const wrongKind = await run(directory, ['keep', 'singer', WHO, '--from', 'src/images.json'], env);
      assert.match(wrongKind.stderr, /src\/images\.json is not a JPEG, PNG or WebP picture\./);
      const long = await run(directory, ['keep', 'dev-night', 'a'.repeat(801)], env);
      assert.match(long.stderr, /The words are 801 characters; keep them to 800/);
      const unchanged = await run(directory, ['keep', 'dev-night', '--replace'], env);
      assert.match(unchanged.stderr, /Nothing to change: give new words, new pictures with --from, or both\./);
      const unknown = await run(directory, ['draw', 'dev-night'], env);
      assert.match(unknown.stderr, /^usage: node scripts\/character\.mjs/);
      const keyless = await run(directory, ['keep', 'dev-night', WHO], { ...env, ANGLES_API_KEY: '' });
      assert.match(keyless.stderr, /ANGLES_API_KEY is not set\. Characters are kept with an Angles account\./);

      for (const result of [wordless, spaced, pictureless, missing, crowded, both, addless, wrongKind, long, unchanged, unknown, keyless]) assert.equal(result.code, 1);
      assert.equal(requests.length, 0);
    }
  );
});

test('does not replace a character already kept unless told to', async () => {
  const taken = {
    status: 409,
    message: 'Conflict',
    details: { code: 'CHARACTER_NAME_TAKEN', message: 'This account already keeps a character named "dev-night". Change that one, or pick another name.' },
  };
  await withAngles(
    request => (request.method === 'POST' ? taken : kept({ description: 'Older now.' })),
    async ({ directory, env, requests }) => {
      const refused = await run(directory, ['keep', 'dev-night', WHO], env);
      assert.equal(refused.code, 1);
      assert.match(refused.stderr, /The account already keeps a character named dev-night\. See them: node scripts\/character\.mjs show dev-night\nTo change that one, add --replace; to keep this one beside it, give it another name\./);

      // New words alone leave the pictures: the picture of the same name here is not sent in their place.
      const reworded = await run(directory, ['keep', 'dev-night', 'Older now.', '--replace'], env);
      assert.equal(reworded.code, 0, reworded.stderr);
      assert.equal(`${requests[1].method} ${requests[1].url}`, 'PUT /characters/dev-night');
      assert.equal(field(requests[1].form, 'description'), 'Older now.');
      assert.equal(field(requests[1].form, 'name'), undefined);
      assert.deepEqual(filesIn(requests[1].form), []);
      assert.match(reworded.stdout, /^Changed dev-night: 1 picture, 10 characters of words\./);

      // New pictures alone leave the words.
      const redrawn = await run(directory, ['keep', 'dev-night', '--replace', '--from', 'side'], env);
      assert.equal(redrawn.code, 0, redrawn.stderr);
      assert.equal(field(requests[2].form, 'description'), undefined);
      assert.deepEqual(filesIn(requests[2].form).map(file => file.name), ['side.png']);
    }
  );
});

test('--add puts pictures after the ones a character has, which are named so that they stay', async () => {
  const has = count => kept({ pictures: Array.from({ length: count }, (_, index) => ({ url: `https://cdn.test/characters/${index + 1}.jpg` })) });
  await withAngles(
    request => (request.method === 'GET' ? has(2) : has(4)),
    async ({ directory, env, requests }) => {
      const added = await run(directory, ['keep', 'dev-night', '--add', '--from', 'side,loose.webp'], env);

      assert.equal(added.code, 0, added.stderr);
      assert.deepEqual(requests.map(request => `${request.method} ${request.url}`), ['GET /characters/dev-night', 'PUT /characters/dev-night']);
      assert.equal(field(requests[1].form, 'keep'), JSON.stringify(['https://cdn.test/characters/1.jpg', 'https://cdn.test/characters/2.jpg']));
      assert.deepEqual(filesIn(requests[1].form).map(file => file.name), ['side.png', 'loose.webp']);
      // Their words are not sent, so they stay.
      assert.equal(field(requests[1].form, 'description'), undefined);
      assert.match(added.stdout, /^Changed dev-night: 4 pictures,/);
    }
  );

  // No room is found out before anything is sent.
  await withAngles(
    () => has(9),
    async ({ directory, env, requests }) => {
      const crowded = await run(directory, ['keep', 'dev-night', '--add', '--from', 'side,loose.webp'], env);
      assert.equal(crowded.code, 1);
      assert.match(crowded.stderr, /dev-night has 9 pictures and a character has at most 10: there is room for 1 more\. --replace --from puts new ones in their place\./);
      assert.deepEqual(requests.map(request => request.method), ['GET']);
    }
  );
});

test('passes on what Angles says when the account has no room for more pictures', async () => {
  const full = {
    status: 400,
    message: 'Bad Request',
    details: { code: 'CHARACTER_PICTURE_LIMIT_REACHED', message: 'An account keeps up to 100 pictures of its characters, and this would make 101. Delete some to keep more.' },
  };
  await withAngles(
    () => full,
    async ({ directory, env }) => {
      const refused = await run(directory, ['keep', 'dev-night', WHO], env);
      assert.equal(refused.code, 1);
      assert.match(refused.stderr, /angles could not keep dev-night: HTTP 400 An account keeps up to 100 pictures of its characters, and this would make 101\. Delete some to keep more\./);
    }
  );
});

test('says so when there is nobody of that name to change, show or delete', async () => {
  const nobody = { status: 404, message: 'Not Found', details: { code: 'CHARACTER_NOT_FOUND', message: 'This account keeps no character named "ghost".' } };
  await withAngles(
    () => nobody,
    async ({ directory, env }) => {
      const changed = await run(directory, ['keep', 'ghost', WHO, '--replace'], env);
      assert.match(changed.stderr, /The account keeps no character named ghost to change\. Leave out --replace to keep a new one\./);
      const added = await run(directory, ['keep', 'ghost', '--add', '--from', 'side'], env);
      assert.match(added.stderr, /The account keeps no character named ghost to add to\. Leave out --add to keep a new one\./);
      assert.equal(added.code, 1);
      const shown = await run(directory, ['show', 'ghost'], env);
      assert.match(shown.stderr, /HTTP 404 This account keeps no character named "ghost"\./);
      const removed = await run(directory, ['remove', 'ghost'], env);
      assert.match(removed.stderr, /The account keeps no character named ghost\./);
      for (const result of [changed, shown, removed]) assert.equal(result.code, 1);
    }
  );
});

test('lists what the account keeps, shows one, and deletes one', async () => {
  const sheets = Array.from({ length: 5 }, (_, index) => ({ url: `https://cdn.test/characters/${index + 1}.jpg`, width: 1728, height: 2304 }));
  const many = { characters: [kept(), kept({ name: '夜班程序员', description: '', pictures: [{ url: 'a' }, { url: 'b' }] })], limits: { pictures: 100, picturesPerCharacter: 10 } };
  await withAngles(
    request => (request.method === 'DELETE' ? { removed: 'dev-night' } : request.url === '/characters' ? many : request.url.endsWith('/crowd') ? kept({ name: 'crowd', pictures: sheets }) : kept()),
    async ({ directory, env, requests }) => {
      const listed = await run(directory, [], env);
      assert.equal(listed.code, 0, listed.stderr);
      assert.equal(`${requests[0].method} ${requests[0].url}`, 'GET /characters');
      assert.match(listed.stdout, /^dev-night\s+1 picture\s+An ordinary programmer of about twenty-eight/);
      assert.match(listed.stdout, /\n夜班程序员\s+2 pictures\s+\(no words\)\n/);
      assert.match(listed.stdout, /\n2 characters, 3 of the 100 pictures an account keeps\. Draw one with: node scripts\/image\.mjs <name> "<what they are doing>" --character <character>\n$/);

      const shown = await run(directory, ['show', '夜班程序员'], env);
      assert.equal(requests[1].url, `/characters/${encodeURIComponent('夜班程序员')}`);
      assert.match(shown.stdout, /^dev-night\nAn ordinary programmer.*\n {3}1 {2}1728×2304 {2}https:\/\/cdn\.test\/characters\/sheet\.jpg\nDraw them with: .* --character dev-night\n$/);

      // With more pictures than one picture is drawn from, each has its number, and how to pick is said.
      const crowd = await run(directory, ['show', 'crowd'], env);
      assert.match(crowd.stdout, /\n {3}1 {2}1728×2304 {2}https:\/\/cdn\.test\/characters\/1\.jpg\n[\s\S]*\n {3}5 {2}1728×2304 {2}https:\/\/cdn\.test\/characters\/5\.jpg\n/);
      assert.match(crowd.stdout, /--character crowd It uses pictures 1 to 3; add --pictures 1,4 to pick others, up to 3\.\n$/);

      const removed = await run(directory, ['remove', 'dev-night'], env);
      assert.equal(`${requests[3].method} ${requests[3].url}`, 'DELETE /characters/dev-night');
      assert.equal(removed.stdout, 'Deleted dev-night from the account. Pictures already drawn of them are untouched.\n');
    }
  );
});

test('says there are none yet, and how to keep the first', async () => {
  await withAngles(
    () => ({ characters: [], limits: { pictures: 100, picturesPerCharacter: 10 } }),
    async ({ directory, env }) => {
      const listed = await run(directory, [], env);
      assert.equal(listed.stdout, 'The account keeps no characters yet. Keep one: node scripts/character.mjs keep <name> "<who they are>"\n');
    }
  );
});
