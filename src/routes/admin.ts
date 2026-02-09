import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { z } from 'zod';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import streamifier from 'streamifier';

// Ensure `.env` is loaded before reading process.env values in this module.
dotenv.config();

const envTrim = (key: string) => {
  const value = process.env[key];
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
};

const PAGE_KEYS = ['home', 'about', 'services', 'products', 'get-started', 'contact'] as const;
type PageKey = (typeof PAGE_KEYS)[number];

const ENV_USERNAME = envTrim('ADMIN_USERNAME') || 'admin';
const ENV_PASSWORD = envTrim('ADMIN_PASSWORD') || 'change-me';
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
  envTrim('CONFIG_DIRECTORY') ||
  path.resolve(process.cwd(), '../public/config');

const PUBLIC_FOLDER =
  envTrim('PUBLIC_DIRECTORY') ||
  path.resolve(process.cwd(), '../public');

const GITHUB_TOKEN = envTrim('GITHUB_TOKEN');
const GITHUB_OWNER = envTrim('GITHUB_OWNER');
const GITHUB_REPO = envTrim('GITHUB_REPO');
const GITHUB_BRANCH = envTrim('GITHUB_BRANCH') || 'main';
const GITHUB_FILE_PATHS: Record<PageKey, string> = {
  home: 'public/config/home.json',
  about: 'public/config/about.json',
  services: 'public/config/services.json',
  products: 'public/config/products.json',
  'get-started': 'public/config/get-started.json',
  contact: 'public/config/contact.json',
};

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(envTrim('ASSET_MAX_BYTES') || 25 * 1024 * 1024) },
});

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

async function ensureAssetDir(folder: string) {
  await fs.promises.mkdir(folder, { recursive: true });
}

function cloudinaryEnabled() {
  return cloudinaryMode() !== 'off';
}

function cloudinaryMode(): 'signed' | 'unsigned' | 'off' {
  const explicit = (envTrim('CLOUDINARY_MODE') || '').toLowerCase();
  if (explicit === 'signed' || explicit === 'unsigned') return explicit;

  const cloudName = envTrim('CLOUDINARY_CLOUD_NAME');
  if (!cloudName) return 'off';

  // Prefer unsigned uploads when a preset is provided, even if API credentials exist.
  const apiKey = envTrim('CLOUDINARY_API_KEY');
  const apiSecret = envTrim('CLOUDINARY_API_SECRET');
  const preset = envTrim('CLOUDINARY_UPLOAD_PRESET');
  if (preset) return 'unsigned';
  if (apiKey && apiSecret) return 'signed';

  return 'off';
}

function configureCloudinaryOnce() {
  if (cloudinaryMode() !== 'signed') return;
  cloudinary.config({
    cloud_name: envTrim('CLOUDINARY_CLOUD_NAME'),
    api_key: envTrim('CLOUDINARY_API_KEY'),
    api_secret: envTrim('CLOUDINARY_API_SECRET'),
  });
}

async function uploadBufferToCloudinary(args: {
  buffer: Buffer;
  mimetype: string;
  folder: string;
  publicId?: string;
}) {
  const resourceType = args.mimetype.startsWith('video/') ? 'video' : 'image';
  const mode = cloudinaryMode();
  if (mode === 'off') {
    throw new Error('Cloudinary is not configured');
  }

  if (mode === 'unsigned') {
    const uploadPreset = envTrim('CLOUDINARY_UPLOAD_PRESET');
    if (!uploadPreset) {
      throw new Error('Cloudinary upload preset missing');
    }

    const cloudName = envTrim('CLOUDINARY_CLOUD_NAME') as string;
    const endpoint = `https://api.cloudinary.com/v1_1/${encodeURIComponent(
      cloudName,
    )}/${resourceType}/upload`;

    const form = new FormData();
    // Node 20 has global Blob/FormData.
    // TS + DOM lib typings don't love Node's Buffer/ArrayBufferLike; runtime is fine.
    form.append('file', new Blob([args.buffer as any], { type: args.mimetype }), args.publicId || 'upload');
    form.append('upload_preset', uploadPreset);
    form.append('folder', args.folder);
    if (args.publicId) {
      form.append('public_id', args.publicId);
    }

    const response = await fetch(endpoint, { method: 'POST', body: form as any });
    const payload: any = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload?.error?.message || payload?.message || `Cloudinary upload failed: ${response.status}`;
      throw new Error(message);
    }

    return {
      url: payload.secure_url || payload.url,
      publicId: payload.public_id,
      resourceType,
    };
  }

  // Signed mode (server-side credentials).
  configureCloudinaryOnce();

  return new Promise<{ url: string; publicId: string; resourceType: string }>((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: args.folder,
        public_id: args.publicId,
        resource_type: resourceType,
      },
      (error, result) => {
        if (error || !result) {
          reject(error || new Error('Cloudinary upload failed'));
          return;
        }
        resolve({
          url: result.secure_url || result.url,
          publicId: result.public_id,
          resourceType,
        });
      },
    );

    streamifier.createReadStream(args.buffer).pipe(uploadStream);
  });
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

async function writeAssetToDisk(folder: string, filename: string, buffer: Buffer) {
  await ensureAssetDir(folder);
  await fs.promises.writeFile(path.join(folder, filename), buffer);
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
    const text = await response.text().catch(() => '');
    const snippet = text ? ` ${text.slice(0, 300)}` : '';
    throw new Error(`GitHub read failed: ${response.status}${snippet}`);
  }
  const body = await response.json();
  const decoded = Buffer.from(body.content, 'base64').toString('utf8');
  return JSON.parse(decoded);
}

async function commitFileToGitHub(githubPath: string, buffer: Buffer, message: string) {
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    throw new Error('GitHub environment variables missing');
  }

  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeGitHubPath(
    githubPath,
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
      message,
      content: buffer.toString('base64'),
      branch: GITHUB_BRANCH,
      sha,
    }),
  });

  if (!putResponse.ok) {
    const text = await putResponse.text();
    throw new Error(`GitHub commit failed: ${putResponse.status} ${text}`);
  }
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

router.post('/auth/secret/assets', authGuard, upload.single('file'), async (req: any, res) => {
  try {
    const file = req.file as { buffer: Buffer; originalname: string; mimetype: string } | undefined;
    if (!file || !file.buffer) {
      return res.status(400).json({ error: 'Missing file' });
    }

    const allowedMime = new Set([
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/webp',
      'image/gif',
      'video/mp4',
      'video/webm',
      'video/quicktime',
    ]);
    if (!allowedMime.has(file.mimetype)) {
      return res.status(400).json({ error: 'Unsupported file type' });
    }

    const folderRaw = (req.body?.folder as string | undefined) || 'uploads';
    const folderSafe = /^[a-zA-Z0-9_-]+$/.test(folderRaw) ? folderRaw : 'uploads';

    // Prefer Cloudinary for both images and videos if configured.
    if (cloudinaryEnabled()) {
      const publicId = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
      const result = await uploadBufferToCloudinary({
        buffer: file.buffer,
        mimetype: file.mimetype,
        folder: folderSafe,
        publicId,
      });
      return res.json({ ok: true, url: result.url, publicId: result.publicId, resourceType: result.resourceType });
    }

    const extFromName = path.extname(file.originalname || '').toLowerCase();
    const ext =
      extFromName && extFromName.length <= 8
        ? extFromName
        : file.mimetype === 'image/png'
          ? '.png'
          : file.mimetype === 'image/webp'
            ? '.webp'
            : file.mimetype === 'image/gif'
              ? '.gif'
              : '.jpg';

    const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    const publicUrlPath = `/${folderSafe}/${filename}`;
    const githubPath = `public/${folderSafe}/${filename}`;
    const commitMessage =
      (req.body?.commitMessage as string | undefined) || `Upload asset ${filename}`;

    await commitFileToGitHub(githubPath, file.buffer, commitMessage);
    try {
      await writeAssetToDisk(path.join(PUBLIC_FOLDER, folderSafe), filename, file.buffer);
    } catch {
      /* ignore local write failure after GitHub commit */
    }

    res.json({ ok: true, path: publicUrlPath, githubPath });
  } catch (error: any) {
    console.error('Asset upload failed', error);
    res.status(500).json({ error: error?.message || 'Asset upload failed' });
  }
});

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
