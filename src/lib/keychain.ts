// Steem Keychain TypeScript Wrapper

declare global {
  interface Window {
    steem_keychain?: {
      requestHandshake: (callback: () => void) => void;
      requestSignBuffer: (
        account: string,
        message: string,
        key: string,
        callback: (response: any) => void
      ) => void;
      requestCustomJson: (
        account: string,
        id: string,
        key: string,
        json: string,
        displayName: string,
        callback: (response: any) => void
      ) => void;
      requestVote: (
        voter: string,
        permlink: string,
        author: string,
        weight: number,
        callback: (response: any) => void
      ) => void;
      requestPost: (
        account: string,
        title: string,
        body: string,
        parent_permlink: string,
        parent_author: string,
        json_metadata: string,
        permlink: string,
        comment_options: string,
        callback: (response: any) => void
      ) => void;
    };
  }
}

export function isKeychainInstalled(): boolean {
  return typeof window !== 'undefined' && !!window.steem_keychain;
}

export async function waitForKeychain(timeoutMs = 1500): Promise<boolean> {
  if (isKeychainInstalled()) return true;

  return new Promise((resolve) => {
    let elapsed = 0;
    const interval = setInterval(() => {
      elapsed += 100;
      if (isKeychainInstalled()) {
        clearInterval(interval);
        resolve(true);
      } else if (elapsed >= timeoutMs) {
        clearInterval(interval);
        resolve(false);
      }
    }, 100);
  });
}

function buildSafeReplyPermlink(parentAuthor: string, parentPermlink: string): string {
  const suffix = Date.now().toString(36);
  const cleanAuthor = parentAuthor.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const cleanParent = parentPermlink.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const prefix = `re-${cleanAuthor}-`;
  const maxParentLen = Math.max(16, 250 - prefix.length - suffix.length - 1);
  const trimmedParent = cleanParent.slice(0, maxParentLen).replace(/-+$/g, '');
  return `${prefix}${trimmedParent}-${suffix}`;
}

export async function loginWithKeychain(
  username: string
): Promise<{ success: boolean; error?: string }> {
  const ready = await waitForKeychain();
  if (!ready) {
    return { success: false, error: 'Steem Keychain extension is not installed.' };
  }

  const message = `Substeem Curation Hub Login: ${Date.now()}`;
  return new Promise((resolve) => {
    window.steem_keychain!.requestSignBuffer(username, message, 'Posting', (response) => {
      if (response && response.success) {
        resolve({ success: true });
      } else {
        resolve({
          success: false,
          error: response?.message || 'Keychain signature cancelled or failed.',
        });
      }
    });
  });
}

export async function broadcastCustomJson(
  account: string,
  id: string,
  payload: Record<string, any>
): Promise<{ success: boolean; txId?: string; result?: any; error?: string }> {
  const ready = await waitForKeychain();
  if (!ready) {
    return { success: false, error: 'Steem Keychain extension not found.' };
  }

  const jsonString = JSON.stringify(payload);

  return new Promise((resolve) => {
    window.steem_keychain!.requestCustomJson(
      account,
      id,
      'Posting',
      jsonString,
      `Substeem Curation: ${payload.action || 'action'}`,
      (response) => {
        if (response && response.success) {
          resolve({
            success: true,
            txId: response.result?.id,
            result: response.result,
          });
        } else {
          resolve({ success: false, error: response?.message || 'Operation cancelled' });
        }
      }
    );
  });
}

export async function executeVote(
  voter: string,
  author: string,
  permlink: string,
  weight: number // 100 to 10000
): Promise<{ success: boolean; txId?: string; error?: string }> {
  const ready = await waitForKeychain();
  if (!ready) {
    return { success: false, error: 'Steem Keychain extension not found.' };
  }

  const clampedWeight = Math.max(-10000, Math.min(10000, Math.round(weight)));

  return new Promise((resolve) => {
    window.steem_keychain!.requestVote(voter, permlink, author, clampedWeight, (response) => {
      if (response && response.success) {
        resolve({ success: true, txId: response.result?.id });
      } else {
        resolve({ success: false, error: response?.message || 'Vote cancelled' });
      }
    });
  });
}

export async function publishGuidanceComment(
  curatorAccount: string,
  parentAuthor: string,
  parentPermlink: string,
  body: string
): Promise<{ success: boolean; permlink?: string; txId?: string; error?: string }> {
  const ready = await waitForKeychain();
  if (!ready) {
    return { success: false, error: 'Steem Keychain extension not found.' };
  }

  const permlink = buildSafeReplyPermlink(parentAuthor, parentPermlink);
  const jsonMetadata = JSON.stringify({
    app: 'substeem-curation-hub/1.0',
    format: 'markdown',
    tags: ['substeem', 'curation-guidance'],
  });

  return new Promise((resolve) => {
    window.steem_keychain!.requestPost(
      curatorAccount,
      '',
      body,
      parentPermlink,
      parentAuthor,
      jsonMetadata,
      permlink,
      '',
      (response) => {
        if (response && response.success) {
          resolve({ success: true, permlink, txId: response.result?.id });
        } else {
          resolve({ success: false, error: response?.message || 'Comment publishing failed' });
        }
      }
    );
  });
}
