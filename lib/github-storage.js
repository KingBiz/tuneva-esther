
const API = "https://api.github.com";

const SETTINGS_FILE = "data/admin-settings.json";
const SETTINGS_CACHE_TTL = 10000;

const readCache = new Map();
const pendingReads = new Map();

function getConfig() {
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  const branch = process.env.GITHUB_BRANCH || "main";

  if (!owner || !repo || !token) {
    throw new Error("GitHub storage environment variables are missing.");
  }

  return { owner, repo, token, branch };
}

function getHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

function getFileURL(owner, repo, path) {
  const safePath = path
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  return `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${safePath}`;
}

function getBlobURL(owner, repo, sha) {
  return `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(sha)}`;
}

function cloneData(data) {
  return JSON.parse(JSON.stringify(data));
}

function decodeBase64(content, path) {
  if (typeof content !== "string" || !content.trim()) {
    throw new Error(`GitHub returned empty file content: ${path}`);
  }

  try {
    return Buffer.from(
      content.replace(/\s/g, ""),
      "base64"
    ).toString("utf8");
  } catch (_) {
    throw new Error(`Could not decode GitHub file content: ${path}`);
  }
}

function parseJSONContent(content, path) {
  let data;

  try {
    data = JSON.parse(content);
  } catch (_) {
    throw new Error(`Invalid JSON stored in ${path}`);
  }

  return data;
}

/*
 * GitHub Contents API fallback.
 *
 * Larger files may have metadata and SHA available
 * without inline content. In that situation, retrieve
 * the actual content through the Git Blobs API.
 */

async function fetchBlobContent(owner, repo, token, sha, path) {
  const response = await fetch(
    getBlobURL(owner, repo, sha),
    {
      headers: getHeaders(token)
    }
  );

  if (!response.ok) {
    throw new Error(
      `GitHub blob read failed (${response.status}): ${await response.text()}`
    );
  }

  const blob = await response.json();

  if (
    !blob.content ||
    blob.encoding !== "base64"
  ) {
    throw new Error(
      `GitHub returned incomplete blob data: ${path}`
    );
  }

  return decodeBase64(blob.content, path);
}

async function fetchJSON(path, fallback) {
  const { owner, repo, token, branch } = getConfig();

  const url =
    `${getFileURL(owner, repo, path)}?ref=${encodeURIComponent(branch)}`;

  const response = await fetch(url, {
    headers: getHeaders(token)
  });

  if (response.status === 404) {
    return {
      data: fallback,
      sha: null
    };
  }

  if (!response.ok) {
    throw new Error(
      `GitHub read failed (${response.status}): ${await response.text()}`
    );
  }

  const file = await response.json();

  if (!file.sha) {
    throw new Error(
      `GitHub did not return a file SHA: ${path}`
    );
  }

  let decoded;

  // Normal Contents API response.

  if (
    typeof file.content === "string" &&
    file.content.trim()
  ) {
    decoded = decodeBase64(file.content, path);

  } else {
    // Fallback for files without inline content.

    decoded = await fetchBlobContent(
      owner,
      repo,
      token,
      file.sha,
      path
    );
  }

  const data = parseJSONContent(decoded, path);

  return {
    data,
    sha: file.sha
  };
}

async function readJSON(path, fallback = {}) {
  const now = Date.now();

  // Cache only admin settings.

  if (path === SETTINGS_FILE) {
    const cached = readCache.get(path);

    if (cached && now < cached.expiresAt) {
      return {
        data: cloneData(cached.data),
        sha: cached.sha
      };
    }
  }

  // Reuse an identical read already in progress.

  if (pendingReads.has(path)) {
    const result = await pendingReads.get(path);

    return {
      data: cloneData(result.data),
      sha: result.sha
    };
  }

  const request = fetchJSON(path, fallback);

  pendingReads.set(path, request);

  try {
    const result = await request;

    if (path === SETTINGS_FILE) {
      readCache.set(path, {
        data: cloneData(result.data),
        sha: result.sha,
        expiresAt: Date.now() + SETTINGS_CACHE_TTL
      });
    }

    return {
      data: cloneData(result.data),
      sha: result.sha
    };

  } finally {
    pendingReads.delete(path);
  }
}

async function writeJSON(path, data, existingSHA = null) {
  const { owner, repo, token, branch } = getConfig();

  const url = getFileURL(owner, repo, path);
  const headers = getHeaders(token);

  let sha = existingSHA;

  // Obtain the current SHA when one was not supplied.

  if (!sha) {
    const lookup = await fetch(
      `${url}?ref=${encodeURIComponent(branch)}`,
      { headers }
    );

    if (lookup.ok) {
      const existing = await lookup.json();

      sha = existing.sha;

    } else if (lookup.status !== 404) {
      throw new Error(
        `GitHub file lookup failed (${lookup.status}): ${await lookup.text()}`
      );
    }
  }

  const content = Buffer.from(
    JSON.stringify(data, null, 2),
    "utf8"
  ).toString("base64");

  const payload = {
    message: `Update ${path}`,
    content,
    branch
  };

  if (sha) {
    payload.sha = sha;
  }

  const response = await fetch(url, {
    method: "PUT",

    headers: {
      ...headers,
      "Content-Type": "application/json"
    },

    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(
      `GitHub write failed (${response.status}): ${await response.text()}`
    );
  }

  const result = await response.json();

  const saved = {
    data,
    sha: result.content?.sha || null
  };

  // Keep the settings cache synchronized.

  if (path === SETTINGS_FILE) {
    readCache.set(path, {
      data: cloneData(data),
      sha: saved.sha,
      expiresAt: Date.now() + SETTINGS_CACHE_TTL
    });
  }

  // Invalidate pending read and stale cache after writes.

  pendingReads.delete(path);

  if (path !== SETTINGS_FILE) {
    readCache.delete(path);
  }

  return saved;
}

module.exports = {
  readJSON,
  writeJSON
};
