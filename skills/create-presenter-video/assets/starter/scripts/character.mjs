#!/usr/bin/env node
// Keeps a character with the user's Angles account (ANGLES_API_KEY), so the
// next project draws the same one instead of a new one.
//
//   node scripts/character.mjs
//       the characters the account keeps
//   node scripts/character.mjs keep dev-night "An ordinary programmer of about twenty-eight, tall, thin and slouching, in pyjama bottoms and a bobbled hoodie. Not handsome, not stylish."
//       keeps the picture named dev-night, and those words, as the character
//       dev-night. --from sheet,side,face keeps other pictures instead: up to
//       ten, each one made here (by its name) or a file, in the order given.
//   node scripts/character.mjs keep dev-night --add --from dev-coat,dev-back
//       adds pictures to the ones a kept character has
//   node scripts/character.mjs keep dev-night --replace --from dev-older
//       changes a character already kept: new words, new pictures with --from,
//       or both. What is left out stays as it is.
//   node scripts/character.mjs show dev-night
//       their words, and their pictures by number
//   node scripts/character.mjs remove dev-night
//       deletes them from the account, for every project
//
// A character is a name, the pictures they are drawn from, and the words that
// go along with the pictures: who they are, and what they must not be drawn
// as. A picture does not hold that second half, which is why the words are
// asked for. Draw one again with: node scripts/image.mjs <name> "<what they
// are doing>" --character dev-night
//
// A character can have several pictures — a full figure, a side view, a close
// face, another outfit — but a new picture is drawn from three at most: the
// first three, or the ones `image.mjs --pictures 1,4` names. So the order they
// are kept in matters, and the first should be the one that says most. An
// account keeps a hundred pictures over all of its characters.
//
// Keeping costs nothing. The pictures go to the account's storage, at links
// that are not listed anywhere but that anyone holding one can open: keep
// characters that were drawn or made, not a photograph of a person.
import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { angles } from './media.mjs';

const MANIFEST = join('src', 'images.json');
const NAME = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,39}$/u;
const LONGEST_WORDS = 800;
const MOST_PICTURES = 10;
const HEAVIEST_PICTURE = 20 * 1024 * 1024;
// What one request carries, with room for the form around the files.
const HEAVIEST_SAVE = 90 * 1024 * 1024;
const MIME_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const MOST_DRAWN_FROM = 3;
const TAKES_A_VALUE = ['--from'];
const USAGE =
  'usage: node scripts/character.mjs\n       node scripts/character.mjs keep <name> "<who they are>" [--from <picture>[,<picture>…]] [--add | --replace]\n       node scripts/character.mjs show <name>\n       node scripts/character.mjs remove <name>';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function option(args, name) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value !== undefined && !value.startsWith('--') ? value : undefined;
}

const pathOf = name => `/characters/${encodeURIComponent(name)}`;
const counted = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const drawWith = name => `node scripts/image.mjs <name> "<what they are doing>" --character ${name}`;

function nameOf(name) {
  if (!name) fail(USAGE);
  if (!NAME.test(name)) fail(`"${name}" cannot be a character's name: up to 40 letters, digits, hyphens and underscores, starting with a letter or digit, with no spaces.`);
  return name;
}

/** The file a picture is in: one this workspace made, by its name, or a file by its path. */
function fileOf(picture, made) {
  const file = made[picture]?.src ? join('public', made[picture].src) : picture;
  if (!existsSync(file)) {
    const names = Object.keys(made);
    fail(`There is no picture "${picture}": not one made here${names.length ? ` (${names.join(', ')})` : ''}, and not a file.`);
  }
  if (!MIME_TYPES[extname(file).toLowerCase()]) fail(`${file} is not a JPEG, PNG or WebP picture.`);
  return file;
}

async function list() {
  const { characters = [], limits } = await angles('GET', '/characters');
  if (!characters.length) {
    process.stdout.write('The account keeps no characters yet. Keep one: node scripts/character.mjs keep <name> "<who they are>"\n');
    return;
  }
  for (const character of characters) {
    const words = character.description ? character.description.replace(/\s+/g, ' ') : '(no words)';
    process.stdout.write(`${character.name.padEnd(20)} ${counted(character.pictures.length, 'picture').padEnd(11)} ${words.length > 90 ? `${words.slice(0, 89)}…` : words}\n`);
  }
  const pictures = characters.reduce((total, character) => total + character.pictures.length, 0);
  process.stdout.write(`\n${counted(characters.length, 'character')}, ${pictures} of the ${limits?.pictures ?? '?'} pictures an account keeps. Draw one with: ${drawWith('<character>')}\n`);
}

async function show(name) {
  const character = await angles('GET', pathOf(name));
  process.stdout.write(`${character.name}\n${character.description || '(no words: only the pictures go along)'}\n`);
  character.pictures.forEach((picture, index) => {
    process.stdout.write(`  ${String(index + 1).padStart(2)}  ${picture.width && picture.height ? `${picture.width}×${picture.height}  ` : ''}${picture.url}\n`);
  });
  const others = character.pictures.length > MOST_DRAWN_FROM ? ` It uses pictures 1 to ${MOST_DRAWN_FROM}; add --pictures 1,${MOST_DRAWN_FROM + 1} to pick others, up to ${MOST_DRAWN_FROM}.` : '';
  process.stdout.write(`Draw them with: ${drawWith(character.name)}${others}\n`);
}

async function keep(name, words, args) {
  const add = args.includes('--add');
  if (add && args.includes('--replace')) fail('--add puts pictures beside the ones kept and --replace puts them in their place: use one.');
  if (add && !option(args, '--from')) fail(`Say which pictures to add: node scripts/character.mjs keep ${name} --add --from <picture>[,<picture>…]`);
  // Both change somebody who is kept already; they differ in what becomes of the pictures they had.
  const replace = add || args.includes('--replace');
  if (words !== undefined && words.trim().length > LONGEST_WORDS) {
    fail(`The words are ${words.trim().length} characters; keep them to ${LONGEST_WORDS}, so that they and a scene still fit in one picture's description.`);
  }
  if (!replace && !words?.trim()) {
    fail(`Say who ${name} is: node scripts/character.mjs keep ${name} "<who they are, and what they must not be drawn as>"\nThe pictures do not hold that, and it goes along every time they are drawn.`);
  }

  const made = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
  if (args.includes('--from') && !option(args, '--from')) fail('--from takes the pictures to keep, separated by commas: names of pictures made here, or files.');
  // Left to itself, a new character is kept from the picture of the same name.
  // One already kept changes its pictures only when told which to change them to.
  const asked = option(args, '--from')?.split(',').map(picture => picture.trim()).filter(Boolean) ?? (!replace && made[name] ? [name] : []);
  if (asked.length > MOST_PICTURES) fail(`A character has at most ${MOST_PICTURES} pictures.`);
  if (!asked.length && !replace) {
    fail(`There is no picture named ${name} here to keep. Say which: node scripts/character.mjs keep ${name} "…" --from <picture>[,<picture>…]`);
  }
  if (!asked.length && words === undefined) fail('Nothing to change: give new words, new pictures with --from, or both.');
  const files = asked.map(picture => fileOf(picture, made));
  const sizes = files.map(file => readFileSync(file).length);
  const heavy = files.find((file, index) => sizes[index] > HEAVIEST_PICTURE);
  if (heavy) fail(`${heavy} is over ${HEAVIEST_PICTURE / 1024 / 1024}MB.`);
  if (sizes.reduce((total, size) => total + size, 0) > HEAVIEST_SAVE) {
    fail(`Together these are over ${HEAVIEST_SAVE / 1024 / 1024}MB, which is more than one call can send. Keep some now and the rest with --add.`);
  }

  // Added pictures go after the ones there are, which have to be named to stay.
  let staying = null;
  if (add) {
    let before;
    try {
      before = await angles('GET', pathOf(name));
    } catch (error) {
      if (/^HTTP 404\b/.test(error.message)) fail(`The account keeps no character named ${name} to add to. Leave out --add to keep a new one.`);
      fail(`angles could not look up ${name}: ${error.message}`);
    }
    staying = before.pictures.map(picture => picture.url);
    if (staying.length + files.length > MOST_PICTURES) {
      fail(`${before.name} has ${counted(staying.length, 'picture')} and a character has at most ${MOST_PICTURES}: there is room for ${MOST_PICTURES - staying.length} more. --replace --from puts new ones in their place.`);
    }
  }

  const form = new FormData();
  if (!replace) form.append('name', name);
  if (words !== undefined) form.append('description', words.trim());
  if (staying) form.append('keep', JSON.stringify(staying));
  for (const file of files) {
    form.append('files', new Blob([readFileSync(file)], { type: MIME_TYPES[extname(file).toLowerCase()] }), basename(file));
  }

  let character;
  try {
    character = replace ? await angles('PUT', pathOf(name), form) : await angles('POST', '/characters', form);
  } catch (error) {
    if (/^HTTP 409\b/.test(error.message)) {
      fail(`The account already keeps a character named ${name}. See them: node scripts/character.mjs show ${name}\nTo change that one, add --replace; to keep this one beside it, give it another name.`);
    }
    if (replace && /^HTTP 404\b/.test(error.message)) fail(`The account keeps no character named ${name} to change. Leave out --replace to keep a new one.`);
    fail(`angles could not keep ${name}: ${error.message}`);
  }
  process.stdout.write(
    `${replace ? 'Changed' : 'Kept'} ${character.name}: ${counted(character.pictures.length, 'picture')}, ${counted(character.description.length, 'character')} of words.\nAny project on this account draws them with: ${drawWith(character.name)}\n`
  );
}

async function remove(name) {
  try {
    await angles('DELETE', pathOf(name));
  } catch (error) {
    if (/^HTTP 404\b/.test(error.message)) fail(`The account keeps no character named ${name}.`);
    throw error;
  }
  process.stdout.write(`Deleted ${name} from the account. Pictures already drawn of them are untouched.\n`);
}

async function main() {
  // A listing piped into `head` closes the pipe early; that is not an error.
  process.stdout.on('error', error => process.exit(error.code === 'EPIPE' ? 0 : 1));
  const args = process.argv.slice(2);
  const [command, name, words, ...rest] = args.filter((arg, index) => !arg.startsWith('--') && !TAKES_A_VALUE.includes(args[index - 1]));
  if (!process.env.ANGLES_API_KEY) fail('ANGLES_API_KEY is not set. Characters are kept with an Angles account.');
  if (command === undefined && !args.length) return list();
  if (rest.length) fail(USAGE);
  if (command === 'keep') return keep(nameOf(name), words, args);
  if (words !== undefined) fail(USAGE);
  if (command === 'show') return show(nameOf(name));
  if (command === 'remove') return remove(nameOf(name));
  fail(USAGE);
}

main().catch(error => fail(error.message));
