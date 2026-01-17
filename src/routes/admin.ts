import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const PAGE_KEYS = ['home', 'services', 'products', 'get-started', 'contact'] as const;
type PageKey = (typeof PAGE_KEYS)[number];

const ENV_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ENV_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';
const ADMIN_CREDENTIALS: Record<string, string> = (() => {
  const fallback: Record<string, string> = { [ENV_USERNAME]: ENV_PASSWORD };
  const raw = process.env.ADMIN_CREDENTIALS;
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      return fallback;
    }
    const creds: Record<string, string> = {};
    Object.entries(parsed).forEach(([user, pass]) => {
      if (typeof user === 'string' && typeof pass === 'string') {
        creds[user] = pass;
      }
    });
    return Object.keys(creds).length ? creds : fallback;
  } catch (error) {
    console.warn('Invalid ADMIN_CREDENTIALS', error);
    return fallback;
  }
})();

const CONFIG_FOLDER =
  process.env.CONFIG_DIRECTORY ||
  path.resolve(process.cwd(), '../public/config');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_FILE_PATHS: Record<PageKey, string> = {
  home: 'public/config/home.json',
  services: 'public/config/services.json',
  products: 'public/config/products.json',
  'get-started': 'public/config/get-started.json',
  contact: 'public/config/contact.json',
};

const router = Router();

const authGuard = (req: any, res: any, next: any) => {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const decoded = Buffer.from(encoded, 'base64').toString();
  const [user, pass] = decoded.split(':');
  if (ADMIN_CREDENTIALS[user] === pass) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
};

const updateSchema = z.object({
  content: z.any(),
  commit: z.boolean().optional().default(false),
  commitMessage: z.string().optional(),
  file: z.enum(PAGE_KEYS).optional().default('home'),
});

const getConfigPath = (page: PageKey) => path.join(CONFIG_FOLDER, `${page}.json`);

const encodeGitHubPath = (input: string) => input.split('/').map(encodeURIComponent).join('/');

async function ensureConfigDir() {
  await fs.promises.mkdir(CONFIG_FOLDER, { recursive: true });
}

async function readFromDisk(page: PageKey) {
  const filePath = getConfigPath(page);
  const raw = await fs.promises.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function writeToDisk(page: PageKey, payload: any) {
  await ensureConfigDir();
  const next = JSON.stringify(payload, null, 2);
  await fs.promises.writeFile(getConfigPath(page), next, 'utf8');
}

async function readFromGitHub(page: PageKey) {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    throw new Error('GitHub variables missing');
  }
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeGitHubPath(
    GITHUB_FILE_PATHS[page],
  )}?ref=${GITHUB_BRANCH}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub read failed: ${response.status}`);
  }
  const body = await response.json();
  const decoded = Buffer.from(body.content, 'base64').toString('utf8');
  return JSON.parse(decoded);
}

async function commitToGitHub(page: PageKey, payload: any, message?: string) {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    throw new Error('GitHub environment variables missing');
  }
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeGitHubPath(
    GITHUB_FILE_PATHS[page],
  )}`;
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
  };
  const getResponse = await fetch(`${url}?ref=${GITHUB_BRANCH}`, { headers });
  let sha: string | undefined;
  if (getResponse.ok) {
    const data = await getResponse.json();
    sha = data?.sha;
  }
  const putResponse = await fetch(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      message: message || `Update ${page} config`,
      content: Buffer.from(JSON.stringify(payload, null, 2)).toString('base64'),
      branch: GITHUB_BRANCH,
      sha,
    }),
  });
  if (!putResponse.ok) {
    const text = await putResponse.text();
    throw new Error(`GitHub commit failed: ${putResponse.status} ${text}`);
  }
}

router.get('/auth/secret/config', authGuard, async (req, res) => {
  const key = (req.query.file as PageKey) || 'home';
  if (!PAGE_KEYS.includes(key)) {
    return res.status(400).json({ error: 'Invalid config key' });
  }
  try {
    const data = await readFromDisk(key).catch(async (err) => {
      if (GITHUB_TOKEN && GITHUB_OWNER && GITHUB_REPO) {
        return readFromGitHub(key);
      }
      throw err;
    });
    res.json({ config: data });
  } catch (error: any) {
    console.error('Failed to read config', error);
    res.status(500).json({ error: error?.message || 'Failed to read config' });
  }
});

router.put('/auth/secret/config', authGuard, async (req, res) => {
  try {
    const body = updateSchema.parse(req.body ?? {});
    const key = body.file;
    if (body.commit) {
      await commitToGitHub(key, body.content, body.commitMessage);
      try {
        await writeToDisk(key, body.content);
      } catch {
        /* ignore local write failure after GitHub commit */
      }
      return res.json({ ok: true, committed: true });
    }
    await writeToDisk(key, body.content);
    res.json({ ok: true, committed: false });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.flatten() });
    }
    console.error('Failed to update config', error);
    res.status(500).json({ error: error?.message || 'Failed to update config' });
  }
});

export default router;
