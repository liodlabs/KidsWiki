import { ensureEditorDraftSchema } from '../../utils/editorDrafts.ts';
import { isUserId, type UserId } from '../../shared/userId.ts';
import { isSuperAdminEmail } from '../../utils/auth.ts';
import { ensureContributorTrustSchema, recalculateContributorTrust } from '../../utils/contributorTrust.ts';
import { ensureUserBadgesSchema } from '../../utils/userBadges.ts';

export interface PendingAccountMerge {
    survivorUserId: UserId;
    absorbedUserId: UserId;
    absorbedIdentity: { provider: string; uid: string };
    browserNonce: string;
}

export type AccountMergeStatus =
    | 'merged'
    | 'same_user'
    | 'user_not_found'
    | 'account_inactive'
    | 'privileged_account'
    | 'provider_conflict'
    | 'draft_conflict'
    | 'pending_edit_conflict';

export interface AccountMergeResult {
    status: AccountMergeStatus;
    revokedSessionIds: string[];
    survivorUserId?: UserId;
    absorbedUserId?: UserId;
}

export function parsePendingAccountMerge(raw: string): PendingAccountMerge | null {
    try {
        const value = JSON.parse(raw) as Partial<PendingAccountMerge>;
        if (!isUserId(value.survivorUserId) || !isUserId(value.absorbedUserId)) return null;
        if (value.survivorUserId === value.absorbedUserId) return null;
        if (!value.absorbedIdentity || typeof value.absorbedIdentity.provider !== 'string' || !value.absorbedIdentity.provider) return null;
        if (typeof value.absorbedIdentity.uid !== 'string' || !value.absorbedIdentity.uid) return null;
        if (typeof value.browserNonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.browserNonce)) return null;
        return value as PendingAccountMerge;
    } catch {
        return null;
    }
}

let aliasSchemaReady: Promise<void> | null = null;

export function ensureUserAliases(db: D1Database): Promise<void> {
    if (!aliasSchemaReady) {
        aliasSchemaReady = db.batch([
            db.prepare(`CREATE TABLE IF NOT EXISTS user_id_aliases (
                alias_id TEXT NOT NULL PRIMARY KEY COLLATE BINARY,
                canonical_user_id TEXT NOT NULL,
                created_at INTEGER NOT NULL DEFAULT (unixepoch()),
                CHECK(alias_id != canonical_user_id),
                FOREIGN KEY (canonical_user_id) REFERENCES users(id)
            )`),
            db.prepare('CREATE INDEX IF NOT EXISTS idx_user_id_aliases_canonical ON user_id_aliases(canonical_user_id)'),
        ]).then(() => undefined).catch((error) => {
            aliasSchemaReady = null;
            throw error;
        });
    }
    return aliasSchemaReady;
}

export async function resolveCanonicalUserId(db: D1Database, userId: UserId): Promise<UserId> {
    await ensureUserAliases(db);
    const alias = await db.prepare('SELECT canonical_user_id FROM user_id_aliases WHERE alias_id = ?')
        .bind(userId)
        .first<{ canonical_user_id: UserId }>();
    return alias?.canonical_user_id ?? userId;
}

export async function resolveCanonicalUserIds(db: D1Database, userIds: UserId[]): Promise<Map<UserId, UserId>> {
    const resolved = new Map<UserId, UserId>(userIds.map(id => [id, id]));
    if (userIds.length === 0) return resolved;
    await ensureUserAliases(db);
    for (let i = 0; i < userIds.length; i += 100) {
        const batch = userIds.slice(i, i + 100);
        const placeholders = batch.map(() => '?').join(',');
        const { results } = await db.prepare(
            `SELECT alias_id, canonical_user_id FROM user_id_aliases WHERE alias_id IN (${placeholders})`,
        ).bind(...batch).all<{ alias_id: UserId; canonical_user_id: UserId }>();
        for (const row of results ?? []) resolved.set(row.alias_id, row.canonical_user_id);
    }
    return resolved;
}

/**
 * 흡수 계정의 로그인 수단과 서비스 데이터를 대표 계정으로 옮기고 흡수 계정을 로그인 불가 상태로 보관한다.
 * 대표 계정의 프로필·권한은 유지하며, 덮어쓸 수 없는 사용자별 초안 충돌은 병합 전에 중단한다.
 */
export async function mergeAccounts(
    db: D1Database,
    preferredSurvivorUserId: UserId,
    otherUserId: UserId,
    superAdminEmails: ReadonlySet<string> = new Set(),
): Promise<AccountMergeResult> {
    const empty = (status: AccountMergeStatus): AccountMergeResult => ({ status, revokedSessionIds: [] });
    if (preferredSurvivorUserId === otherUserId) return empty('same_user');

    await ensureUserAliases(db);

    const { results: users } = await db.prepare(
        'SELECT id, provider, uid, role, banned_until, email, created_at FROM users WHERE id IN (?, ?)',
    ).bind(preferredSurvivorUserId, otherUserId).all<{
        id: UserId;
        provider: string;
        uid: string;
        role: string;
        banned_until: number | null;
        email: string | null;
        created_at: number;
    }>();
    if ((users ?? []).length !== 2) return empty('user_not_found');

    const now = Math.floor(Date.now() / 1000);
    if (users.some(user => user.role === 'deleted' || user.role === 'banned' || (user.banned_until ?? 0) > now)) {
        return empty('account_inactive');
    }

    const { results: identities } = await db.prepare(
        `SELECT user_id, provider, provider_uid AS uid, provider_email, created_at
         FROM user_identities WHERE user_id IN (?, ?)`,
    ).bind(preferredSurvivorUserId, otherUserId).all<{
        user_id: UserId;
        provider: string;
        uid: string;
        provider_email: string | null;
        created_at: number;
    }>();

    const adminEmailByUserId = new Map<UserId, string | null>();
    for (const user of users) {
        const emails = [
            user.email,
            ...(identities ?? [])
                .filter(identity => identity.user_id === user.id)
                .map(identity => identity.provider_email),
        ];
        adminEmailByUserId.set(
            user.id,
            emails.find(email => isSuperAdminEmail(email, superAdminEmails)) ?? null,
        );
    }
    const isSuperAdminAccount = (user: (typeof users)[number]): boolean =>
        user.role === 'super_admin' || adminEmailByUserId.get(user.id) !== null;
    if (users.some(user => user.role !== 'user' && !isSuperAdminAccount(user))) {
        return empty('privileged_account');
    }

    const preferred = users.find(user => user.id === preferredSurvivorUserId)!;
    const other = users.find(user => user.id === otherUserId)!;
    const preferredIsSuperAdmin = isSuperAdminAccount(preferred);
    const otherIsSuperAdmin = isSuperAdminAccount(other);
    let survivor = preferred;
    let absorbed = other;
    if (preferredIsSuperAdmin !== otherIsSuperAdmin) {
        [survivor, absorbed] = preferredIsSuperAdmin ? [preferred, other] : [other, preferred];
    } else if (preferredIsSuperAdmin && otherIsSuperAdmin) {
        const preferredIsOlder = preferred.created_at < other.created_at
            || (preferred.created_at === other.created_at && preferred.id < other.id);
        [survivor, absorbed] = preferredIsOlder ? [preferred, other] : [other, preferred];
    }
    const survivorUserId = survivor.id;
    const absorbedUserId = absorbed.id;
    const allIdentities = identities ?? [];
    const survivorPrimary = allIdentities.find(identity =>
        identity.user_id === survivorUserId
        && identity.provider === survivor.provider
        && identity.uid === survivor.uid,
    );
    const survivorPrimaryEmail = survivorPrimary?.provider_email ?? survivor.email;
    const protectedIdentity = survivorPrimary && isSuperAdminEmail(survivorPrimaryEmail, superAdminEmails)
        ? survivorPrimary
        : allIdentities
            .filter(identity => identity.user_id === survivorUserId)
            .filter(identity => isSuperAdminEmail(identity.provider_email, superAdminEmails))
            .sort((a, b) => a.created_at - b.created_at || a.provider.localeCompare(b.provider))[0]
            ?? allIdentities
                .filter(identity => isSuperAdminEmail(identity.provider_email, superAdminEmails))
                .sort((a, b) => a.created_at - b.created_at || a.provider.localeCompare(b.provider))[0];
    const targetPrimary = protectedIdentity ?? survivorPrimary;
    const targetPrimaryEmail = targetPrimary?.provider_email
        ?? (targetPrimary === survivorPrimary ? survivor.email : null);

    const survivorProviders = new Set(allIdentities.filter(row => row.user_id === survivorUserId).map(row => row.provider));
    if (allIdentities.some(row => row.user_id === absorbedUserId && survivorProviders.has(row.provider))) {
        return empty('provider_conflict');
    }

    await ensureEditorDraftSchema(db);
    const [draftConflict, pendingEditConflict, editorDraftConflict] = await Promise.all([
        db.prepare(`SELECT 1 FROM mcp_drafts a
                    JOIN mcp_drafts b ON b.slug = a.slug AND b.user_id = ?
                    WHERE a.user_id = ? LIMIT 1`)
            .bind(absorbedUserId, survivorUserId)
            .first(),
        db.prepare(`SELECT 1 FROM pending_edits a
                    JOIN pending_edits b ON b.slug = a.slug AND b.author_id = ?
                    WHERE a.author_id = ? LIMIT 1`)
            .bind(absorbedUserId, survivorUserId)
            .first(),
        db.prepare(`SELECT 1 FROM editor_drafts a JOIN editor_drafts b
                    ON b.draft_key = a.draft_key AND b.user_id = ? WHERE a.user_id = ? LIMIT 1`)
            .bind(absorbedUserId, survivorUserId).first(),
    ]);
    if (draftConflict || editorDraftConflict) return empty('draft_conflict');
    if (pendingEditConflict) return empty('pending_edit_conflict');

    await ensureContributorTrustSchema(db);
    await ensureUserBadgesSchema(db);

    const sessionRows = await db.prepare('SELECT id FROM sessions WHERE user_id = ?')
        .bind(absorbedUserId)
        .all<{ id: string }>();
    const revokedSessionIds = (sessionRows.results ?? []).map(row => row.id);

    const statements = [
        db.prepare("UPDATE users SET provider = 'retired', uid = id WHERE id = ?").bind(absorbedUserId),
        ...(targetPrimary ? [
            db.prepare(`UPDATE users SET provider = 'retired', uid = id
                        WHERE id != ? AND role = 'deleted' AND provider = ? AND uid = ?`)
                .bind(survivorUserId, targetPrimary.provider, targetPrimary.uid),
        ] : []),
        db.prepare('UPDATE user_id_aliases SET canonical_user_id = ? WHERE canonical_user_id = ?')
            .bind(survivorUserId, absorbedUserId),
        db.prepare(`INSERT INTO user_id_aliases (alias_id, canonical_user_id)
                    VALUES (?, ?)
                    ON CONFLICT(alias_id) DO UPDATE SET canonical_user_id = excluded.canonical_user_id`)
            .bind(absorbedUserId, survivorUserId),
        db.prepare('UPDATE user_identities SET user_id = ? WHERE user_id = ?').bind(survivorUserId, absorbedUserId),
        ...(targetPrimary ? [
            db.prepare(`UPDATE users SET provider = ?, uid = ?, email = ?
                        WHERE id = ? AND EXISTS (
                            SELECT 1 FROM user_identities
                            WHERE user_id = ? AND provider = ? AND provider_uid = ?
                        )`)
                .bind(
                    targetPrimary.provider,
                    targetPrimary.uid,
                    targetPrimaryEmail,
                    survivorUserId,
                    survivorUserId,
                    targetPrimary.provider,
                    targetPrimary.uid,
                ),
        ] : []),
        db.prepare('UPDATE revisions SET author_id = ? WHERE author_id = ?').bind(survivorUserId, absorbedUserId),
        db.prepare('UPDATE media SET uploader_id = ? WHERE uploader_id = ?').bind(survivorUserId, absorbedUserId),
        db.prepare('UPDATE category_acl SET created_by = ? WHERE created_by = ?').bind(survivorUserId, absorbedUserId),
        db.prepare('UPDATE notifications SET user_id = ? WHERE user_id = ?').bind(survivorUserId, absorbedUserId),
        db.prepare('UPDATE messages SET sender_id = ? WHERE sender_id = ?').bind(survivorUserId, absorbedUserId),
        db.prepare('UPDATE messages SET receiver_id = ? WHERE receiver_id = ?').bind(survivorUserId, absorbedUserId),
        db.prepare('UPDATE discussions SET author_id = ? WHERE author_id = ?').bind(survivorUserId, absorbedUserId),
        db.prepare('UPDATE discussion_comments SET author_id = ? WHERE author_id = ?').bind(survivorUserId, absorbedUserId),
        db.prepare('UPDATE tickets SET user_id = ? WHERE user_id = ?').bind(survivorUserId, absorbedUserId),
        db.prepare('UPDATE ticket_comments SET author_id = ? WHERE author_id = ?').bind(survivorUserId, absorbedUserId),
        db.prepare('UPDATE admin_log SET user = ? WHERE user = ?').bind(survivorUserId, absorbedUserId),
        db.prepare('UPDATE mcp_drafts SET user_id = ? WHERE user_id = ?').bind(survivorUserId, absorbedUserId),
        db.prepare('UPDATE editor_drafts SET user_id = ? WHERE user_id = ?').bind(survivorUserId, absorbedUserId),
        db.prepare('UPDATE pending_edits SET author_id = ? WHERE author_id = ?').bind(survivorUserId, absorbedUserId),
        db.prepare(`INSERT INTO contributor_trust
                        (user_id, status, mode, cycle_started_at, cooldown_until, trusted_since, updated_at)
                    SELECT ?, status, mode, cycle_started_at, cooldown_until, trusted_since, updated_at
                    FROM contributor_trust WHERE user_id = ?
                    ON CONFLICT(user_id) DO NOTHING`)
            .bind(survivorUserId, absorbedUserId),
        db.prepare(`INSERT OR IGNORE INTO contributor_trust_events
                        (user_id, event_type, source_type, source_id, document_key, actor_id, reason, created_at)
                    SELECT ?, event_type, source_type, source_id, document_key, actor_id, reason, created_at
                    FROM contributor_trust_events WHERE user_id = ?`)
            .bind(survivorUserId, absorbedUserId),
        db.prepare('DELETE FROM contributor_trust_events WHERE user_id = ?').bind(absorbedUserId),
        db.prepare('DELETE FROM contributor_trust WHERE user_id = ?').bind(absorbedUserId),
        db.prepare(`INSERT OR IGNORE INTO user_badges (user_id, badge_key, assigned_by, assigned_at)
                    SELECT ?, badge_key, assigned_by, assigned_at FROM user_badges WHERE user_id = ?`)
            .bind(survivorUserId, absorbedUserId),
        db.prepare('DELETE FROM user_badges WHERE user_id = ?').bind(absorbedUserId),
        db.prepare('UPDATE signup_requests SET reviewed_by = ? WHERE reviewed_by = ?').bind(survivorUserId, absorbedUserId),
        db.prepare(`INSERT OR IGNORE INTO discussion_mutes (user_id, discussion_id, created_at)
                    SELECT ?, discussion_id, created_at FROM discussion_mutes WHERE user_id = ?`)
            .bind(survivorUserId, absorbedUserId),
        db.prepare('DELETE FROM discussion_mutes WHERE user_id = ?').bind(absorbedUserId),
        db.prepare(`INSERT INTO page_watches (user_id, page_id, scope, created_at)
                    SELECT ?, page_id, scope, created_at FROM page_watches WHERE user_id = ?
                    ON CONFLICT(user_id, page_id) DO UPDATE SET
                      scope = CASE WHEN page_watches.scope = 'subtree' OR excluded.scope = 'subtree' THEN 'subtree' ELSE 'this' END,
                      created_at = MIN(page_watches.created_at, excluded.created_at)`)
            .bind(survivorUserId, absorbedUserId),
        db.prepare('DELETE FROM page_watches WHERE user_id = ?').bind(absorbedUserId),
        db.prepare(`INSERT OR IGNORE INTO category_watches (user_id, category, created_at)
                    SELECT ?, category, created_at FROM category_watches WHERE user_id = ?`)
            .bind(survivorUserId, absorbedUserId),
        db.prepare('DELETE FROM category_watches WHERE user_id = ?').bind(absorbedUserId),
        db.prepare('UPDATE category_prefix_rules SET created_by = ? WHERE created_by = ?').bind(survivorUserId, absorbedUserId),
        db.prepare('UPDATE doc_setting_prefix_rules SET created_by = ? WHERE created_by = ?').bind(survivorUserId, absorbedUserId),
        db.prepare('UPDATE palettes SET created_by = ? WHERE created_by = ?').bind(survivorUserId, absorbedUserId),
        db.prepare('UPDATE push_subscriptions SET user_id = ? WHERE user_id = ?').bind(survivorUserId, absorbedUserId),
        db.prepare('UPDATE oauth_clients SET created_by_user_id = ? WHERE created_by_user_id = ?').bind(survivorUserId, absorbedUserId),
        db.prepare('UPDATE oauth_codes SET used_at = COALESCE(used_at, unixepoch()) WHERE user_id = ?').bind(absorbedUserId),
        db.prepare('UPDATE oauth_tokens SET revoked_at = COALESCE(revoked_at, unixepoch()) WHERE user_id = ?').bind(absorbedUserId),
        db.prepare('DELETE FROM mcp_api_keys WHERE user_id = ?').bind(absorbedUserId),
        db.prepare('DELETE FROM qr_login_sessions WHERE approved_user_id = ?').bind(absorbedUserId),
        db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(absorbedUserId),
        db.prepare(`UPDATE users
                    SET role = 'deleted', name = '통합된 사용자', picture = NULL, picture_private = 1,
                        email = NULL, banned_until = NULL
                    WHERE id = ?`).bind(absorbedUserId),
    ];
    await db.batch(statements);
    await recalculateContributorTrust(db, survivorUserId).catch(error => {
        console.error('Failed to recalculate contributor trust after account merge:', error);
    });

    return { status: 'merged', revokedSessionIds, survivorUserId, absorbedUserId };
}
