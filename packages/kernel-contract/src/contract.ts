import { oc } from '@orpc/contract';
import { z } from 'zod';
import {
  zBulkApproveItems,
  zAccount,
  zAgentBudget,
  zAgentRisk,
  zAgentRoleKey,
  zAgentScope,
  zAgentStatus,
  zAgentTemplate,
  zAiAmount,
  zChart,
  zClientOverviews,
  zJobDescription,
  zModuleId,
  zPositionStatus,
  zTask,
  zTaskDetail,
  zTaskStatus,
  zAccountCode,
  zChannelConnection,
  zOAuthProvider,
  zOAuthState,
  zSocialDecide,
  zSocialPost,
  zSocialPostCreate,
  zSocialPostUpdate,
  zSocialQueue,
  zSocialMetricsRow,
  zSocialChannelInsights,
  zSocialBioPage,
  zSocialBioSave,
  zSocialFeed,
  zSocialIdea,
  zSocialIdeaCreate,
  zSocialIdeaUpdate,
  zSocialLibraryItem,
  zSocialLibraryUse,
  zSocialReportLink,
  zSocialReportSchedule,
  zSocialReportScheduleSave,
  zSocialReportLinkCreate,
  zSocialLinkPreview,
  zSocialNotificationKind,
  zSocialNotifications,
  zSocialAccountTrend,
  zSocialSnippet,
  zSocialSnippetCreate,
  zSocialSnippetUpdate,
  zSocialLabel,
  zSocialLabelCreate,
  zSocialLabelUpdate,
  zSocialReviewLinks,
  zSocialActivityItem,
  zSocialQueueSet,
  zSocialSchedule,
  zSocialVariantUpdate,
  zSocialChannelInput,
  SOCIAL_POST_STATUSES,
  MAX_BATCH_FILES,
  zBatchFile,
  zFileStatus,
  zId,
  zInboxDetail,
  zInboxItem,
  zInvite,
  zInviteCreated,
  zInvitePreview,
  zInviteRole,
  zInviteToken,
  zJournalEntry,
  zJournalReversal,
  zLocalDate,
  zMe,
  zOrgDetail,
  zOrgExport,
  zOrgSummary,
  zParty,
  zProposalStatus,
  zPurchaseDocument,
  zRole,
  zSession,
  zSessionRevoke,
  zVatPeriod,
  zVatFilingPeriod,
  zVatReport,
  zAccountLedger,
  zFinancialStatements,
  zLedgerPeriod,
  zLedgerReport,
  zPeriodLockInput,
  zPeriodLockState,
  zPeriodUnlockInput,
  zTaxRegistryEntry,
  zVoucherType,
} from './schemas.ts';
import { zCashVoucherPage, zCashVoucherRequest, zVoucherCursor } from './cash-voucher.ts';
import { zOpeningBalanceImport, zOpeningBalancePreview } from './opening-balance.ts';
import { zPortalReconciliation } from './portal-list.ts';
import { zBankImportPreview, zBankImportResult, zBankLineVoucher, zBankLines, zBankOpenLines, zBankStatementImport } from './bank-statement.ts';

// The org for org-scoped procedures comes from the `x-crove-org` header (slug), never from input.
export const contract = {
  me: {
    get: oc.output(zMe),
    // The multi-client home screen (issue #318): the orgs of me.get (at most 200) with their figures, each read in its
    // own org, and how many orgs the user has (#495). One at a time per user: a second while the first runs is
    // refused with OVERLOADED (503).
    clients: oc.output(zClientOverviews),
  },
  org: {
    // A retry with the same idempotencyKey returns the org the first request created.
    create: oc.input(z.object({ name: z.string().trim().min(1).max(200), idempotencyKey: zId })).output(zOrgSummary),
    get: oc.output(zOrgDetail),
    // Owners and admins (issue #313): the org's own tax code (MST), or null to clear it. Stored normalized; a value
    // that is not a Vietnamese tax code is refused. Invoices read from then on whose seller has it become sales.
    setTaxCode: oc.input(z.object({ taxCode: z.string().trim().max(20).nullable() })).output(z.object({ taxCode: z.string().nullable() })),
    // Owners and admins (issue #318): how often the org files its VAT return, or null to clear it.
    setVatFilingPeriod: oc
      .input(z.object({ vatFilingPeriod: zVatFilingPeriod.nullable() }))
      .output(z.object({ vatFilingPeriod: zVatFilingPeriod.nullable() })),
    // Owners and admins (issue #324): the org's address, or null to clear it. Stored on one line, at most 500
    // characters; a value with control characters is refused.
    setAddress: oc.input(z.object({ address: z.string().max(2000).nullable() })).output(z.object({ address: z.string().nullable() })),
    // Owners and admins (admins cannot invite admins). R3: needs fresh MFA. Nobody becomes a member until the
    // invitee accepts (invites.accept). The answer is the same whether or not the email has an account.
    invite: oc.input(z.object({ email: z.email().max(320), role: zInviteRole })).output(zInviteCreated),
    // Owners and admins: the org's invites that are still pending or expired, newest first.
    listInvites: oc.output(z.array(zInvite)),
    revokeInvite: oc.input(z.object({ inviteId: zId })).output(z.object({ ok: z.literal(true) })),
    // Owner only. Retires the org's inbound email address for good and returns the new one (null when the server
    // has no inbound domain). A retry with the same idempotencyKey does not rotate again.
    rotateInbound: oc.input(z.object({ idempotencyKey: zId })).output(z.object({ inboundAddress: z.string().nullable() })),
    // Owners only (R3). A retry with the same idempotencyKey returns the first result.
    changeMemberRole: oc
      .input(z.object({ userId: zId, role: zRole, idempotencyKey: zId }))
      .output(z.object({ userId: zId, role: zRole, previousRole: zRole })),
    removeMember: oc.input(z.object({ userId: zId, idempotencyKey: zId })).output(z.object({ userId: zId, previousRole: zRole })),
    // Owner only (R3, issue #38): the owner types the org's slug to confirm. The org moves to 'offboarding', where only
    // owners can enter it, and the worker exports its data. Run again while offboarding, it asks for a new export.
    offboard: oc
      .input(z.object({ confirmSlug: z.string().max(48), idempotencyKey: zId }))
      .output(z.object({ status: z.literal('offboarding'), exportRequested: z.literal(true) })),
    // Owner only: the offboarding state and the newest finished export.
    export: oc.output(zOrgExport),
  },
  // Org-less (issue #324): the public tax registry's name and address for a tax code, to prefill a new org. Answers
  // TAX_LOOKUP_DISABLED (404) when the server has no lookup configured (TAX_CODE_LOOKUP_URL), INVALID_TAX_CODE (422),
  // TAX_CODE_NOT_FOUND (404) when the registry does not know the code, and TAX_LOOKUP_UNAVAILABLE (503).
  taxRegistry: {
    lookup: oc.input(z.object({ taxCode: z.string().trim().max(20) })).output(zTaxRegistryEntry),
  },
  // Org-less: the signed-in invitee previews and accepts an invite by its token. Only the invited email may.
  invites: {
    peek: oc.input(z.object({ token: zInviteToken })).output(zInvitePreview),
    accept: oc.input(z.object({ token: zInviteToken })).output(zOrgSummary),
  },
  // Sessions (devices) of a member of the org in the header. API only; the screen is a follow-up.
  sessions: {
    list: oc.input(z.object({ userId: zId })).output(z.array(zSession)),
    revoke: oc.input(zSessionRevoke).output(z.object({ revoked: z.array(zId) })),
  },
  // Connected channel accounts (ADR-0025). Every member lists them; owners and admins connect and disconnect.
  channels: {
    list: oc.input(z.object({ includeRevoked: z.boolean().optional() })).output(z.array(zChannelConnection)),
    // The offline sandbox channel, when the deployment enables it. Connecting again with the same key reconnects the
    // same sandbox account.
    connectSandbox: oc
      .input(z.object({ displayName: z.string().trim().min(1).max(200), key: zId }))
      .output(z.object({ connectionId: zId, reconnected: z.boolean() })),
    disconnect: oc.input(z.object({ connectionId: zId, idempotencyKey: zId })).output(z.object({ connectionId: zId, status: z.literal('revoked') })),
    // Bluesky with an app password (S9): checked once by opening a session, then sealed; the account password is refused.
    connectBluesky: oc
      // The format of an app password is checked by the server, which says so in words rather than as a validation error.
      .input(z.object({ handle: z.string().trim().min(3).max(260), appPassword: z.string().trim().min(1).max(100) }))
      .output(z.object({ connectionId: zId, reconnected: z.boolean() })),
    // A Telegram channel (#747): a bot token from @BotFather and the channel's @username, t.me link or numeric id. The
    // server checks the bot may post there, then seals the token; the formats are checked by the server, in words.
    connectTelegram: oc
      .input(z.object({ botToken: z.string().trim().min(1).max(100), channel: z.string().trim().min(1).max(100) }))
      .output(z.object({ connectionId: zId, reconnected: z.boolean() })),
    // Connecting through a provider's OAuth dialog (Social plan S6). Start returns where to send the browser; the
    // provider sends it back to /channels/oauth/:provider/callback, and that screen finishes the attempt with the code
    // and state. Finish connects every account the grant covers (for Facebook, the Pages picked in Meta's dialog).
    oauthStart: oc
      .input(z.object({ provider: zOAuthProvider }))
      .output(z.object({ authorizeUrl: z.url({ protocol: /^https$/ }), state: zOAuthState, expiresAt: z.iso.datetime({ offset: true }) })),
    oauthFinish: oc
      .input(z.object({ provider: zOAuthProvider, state: zOAuthState, code: z.string().min(1).max(2048) }))
      .output(
        z.object({
          connections: z.array(z.object({ connectionId: zId, displayName: z.string(), reconnected: z.boolean() })),
          // Accounts of the grant that did not connect, with the error code; the others stay connected.
          failed: z.array(z.object({ displayName: z.string(), code: z.string() })),
          // Accounts of the grant beyond what one request connects.
          skipped: z.number().int().min(0),
        }),
      ),
  },
  // Crove Social (Social plan §3.3), when the deployment runs the social module.
  social: {
    posts: {
      list: oc
        .input(
          z.object({
            from: z.iso.datetime({ offset: true }).optional(),
            to: z.iso.datetime({ offset: true }).optional(),
            status: z.enum(SOCIAL_POST_STATUSES).optional(),
            // The Social home's lists: a channel in review; drafts with none in review; went out or stopped.
            stage: z.enum(['review', 'drafts', 'done', 'attention']).optional(),
            connectionId: zId.optional(),
            // Posts with this label (#639).
            labelId: zId.optional(),
            // Posts assigned to the viewer (#640).
            assignee: z.literal('me').optional(),
            search: z.string().trim().min(1).max(200).optional(),
            // The last post of the previous page (newest change first).
            before: z.strictObject({ updatedAt: z.iso.datetime({ offset: true }), postId: zId }).optional(),
            limit: z.number().int().min(1).max(200).optional(),
          }),
        )
        .output(z.array(zSocialPost)),
      get: oc.input(z.object({ postId: zId })).output(zSocialPost),
      // Who should move the post along and by when (#640): owners, admins and the author; null clears.
      assign: oc
        .input(z.strictObject({ postId: zId, assigneeUserId: zId.nullable(), dueAt: z.iso.datetime({ offset: true }).nullable() }))
        .output(z.object({ postId: zId, assigneeUserId: zId.nullable(), dueAt: z.string().nullable() })),
      // A retry with the same idempotencyKey returns the first result instead of a second post.
      create: oc
        .input(zSocialPostCreate.extend({ idempotencyKey: zId }))
        .output(z.object({ postId: zId, revision: z.number().int(), variants: z.array(z.object({ variantId: zId, connectionId: zId })) })),
      update: oc.input(zSocialPostUpdate).output(z.object({ postId: zId, revision: z.number().int(), changedVariants: z.array(zId) })),
      addChannels: oc
        .input(z.strictObject({ postId: zId, channels: z.array(zSocialChannelInput).min(1).max(20) }))
        .output(z.object({ postId: zId, variants: z.array(z.object({ variantId: zId, connectionId: zId })) })),
      submit: oc.input(z.strictObject({ postId: zId, variantIds: z.array(zId).min(1).max(20).optional() })).output(z.object({ postId: zId, submitted: z.array(zId) })),
      // A new post with the content of a published one, for the channels it went out on (S9); it is reviewed as usual.
      repost: oc.input(z.strictObject({ postId: zId })).output(z.object({ postId: zId })),
      // Drafts from a sheet (#586), up to 200 rows; with submit, the channels that fit their rules go to review.
      import: oc
        .input(
          z.strictObject({
            posts: z
              .array(
                z.strictObject({
                  body: zSocialPostCreate.shape.body,
                  title: zSocialPostCreate.shape.title,
                  linkUrl: zSocialPostCreate.shape.linkUrl,
                  scheduledAt: zSocialPostCreate.shape.scheduledAt,
                  timeZone: zSocialPostCreate.shape.timeZone,
                  connectionIds: z.array(zId).min(1).max(20),
                }),
              )
              .min(1)
              .max(200),
            submit: z.boolean().optional(),
            // One key per import: a retry after a lost answer returns the first result.
            idempotencyKey: zId,
          }),
        )
        .output(z.object({ posts: z.array(z.object({ postId: zId, submitted: z.number().int() })) })),
      // Internal comments (#582): never published; the author may fix one for 15 minutes.
      comment: oc.input(z.strictObject({ postId: zId, variantId: zId.optional(), body: z.string().trim().min(1).max(4000) })).output(z.object({ commentId: zId })),
      editComment: oc.input(z.strictObject({ commentId: zId, body: z.string().trim().min(1).max(4000) })).output(z.object({ commentId: zId, postId: zId })),
      // The post's timeline, newest first: comments, decisions and what happened to it and its channels.
      activity: oc.input(z.object({ postId: zId })).output(z.object({ items: z.array(zSocialActivityItem), more: z.boolean() })),
      // The post's labels become exactly these (#639); its content and revision stay as they are.
      setLabels: oc
        .input(z.strictObject({ postId: zId, labelIds: z.array(zId).max(10) }))
        .output(z.object({ postId: zId, labelIds: z.array(zId) })),
      // A copy of any post as a new draft, for the channels still connected (#575).
      duplicate: oc.input(z.strictObject({ postId: zId })).output(z.object({ postId: zId })),
      // Repost a published post every N days (7 to 365), each repost sent to review; null stops it.
      setEvergreen: oc.input(z.strictObject({ postId: zId, days: z.number().int().min(7).max(365).nullable() })).output(z.object({ postId: zId, evergreenDays: z.number().int().nullable() })),
      // AI drafting (Social plan §3.7): the server asks the deployment's model for a draft from the brief and saves it as
      // a new post with origin 'ai' (tainted), one variant per channel. Each call drafts anew: a draft whose answer was
      // lost is only an extra draft, which publishes nothing until a person approves it.
      draftWithAi: oc
        .input(
          z.strictObject({
            brief: z.string().trim().min(1).max(4000),
            connectionIds: z.array(zId).min(1).max(20),
            tone: z.string().trim().max(300).optional(),
            language: z.enum(['vi', 'en']).optional(),
          }),
        )
        .output(z.object({ postId: zId })),
      // A rewrite of one text, as a proposal the member accepts or discards (#583); nothing is saved. With a channel,
      // the rewrite is told its limits.
      rewriteWithAi: oc
        .input(
          z.strictObject({
            text: z.string().trim().min(1).max(20_000),
            title: z.string().trim().max(500).nullable().optional(),
            action: z.enum(['shorten', 'formal', 'casual', 'translate_en', 'translate_vi']),
            connectionId: zId.optional(),
          }),
        )
        .output(z.object({ text: z.string(), title: z.string().nullable() })),
    },
    // How published posts did (S8): the latest capture of each variant published in the last days days (30 by default).
    metrics: {
      // postId: that post's published channels, whenever they went out.
      // labelId: only posts with that label (#639).
      summary: oc.input(z.object({ days: z.number().int().min(1).max(365).optional(), postId: zId.optional(), labelId: zId.optional() })).output(z.array(zSocialMetricsRow)),
      // What works (#705): each channel's posts against its own median, by label, format, weekday, hour and hashtag.
      insights: oc
        .input(z.object({ days: z.number().int().min(1).max(365), labelId: zId.optional(), timeZone: z.string().min(1).max(64) }))
        .output(z.object({ channels: z.array(zSocialChannelInsights), truncated: z.boolean() })),
      // The window as a CSV file (UTF-8 with a byte order mark); every export is audited.
      export: oc
        .input(z.strictObject({ days: z.number().int().min(1).max(365), labelId: zId.optional() }))
        .output(z.object({ filename: z.string(), csv: z.string(), truncated: z.boolean() })),
    },
    // Labels for posts (#639): members create them and put them on posts; owners and admins rename and delete them.
    labels: {
      list: oc.input(z.object({})).output(z.array(zSocialLabel)),
      create: oc.input(zSocialLabelCreate).output(z.object({ labelId: zId })),
      update: oc.input(zSocialLabelUpdate).output(z.object({ labelId: zId })),
      remove: oc.input(z.strictObject({ labelId: zId })).output(z.object({ labelId: zId })),
    },
    // The ideas board (#701): members add, change and move ideas; a draft made from one names it (posts.create ideaId).
    ideas: {
      list: oc.input(z.object({ archived: z.boolean().optional(), labelId: zId.optional() })).output(z.object({ ideas: z.array(zSocialIdea), truncated: z.boolean() })),
      get: oc.input(z.object({ ideaId: zId })).output(zSocialIdea),
      create: oc.input(zSocialIdeaCreate).output(z.object({ ideaId: zId })),
      update: oc.input(zSocialIdeaUpdate).output(z.object({ ideaId: zId })),
      move: oc.input(z.strictObject({ ideaId: zId, stage: z.enum(['new', 'planned', 'archived']) })).output(z.object({ ideaId: zId, stage: z.string() })),
    },
    // The org's link-in-bio page (#707): everyone reads it and its clicks; owners and admins save it.
    bio: {
      get: oc.input(z.object({})).output(zSocialBioPage.nullable()),
      save: oc.input(zSocialBioSave).output(z.object({ pageId: zId, slug: z.string() })),
    },
    // Blog feeds that become drafts (#708): owners and admins add, change, pause and remove them; everyone reads them.
    feeds: {
      list: oc.input(z.object({})).output(z.array(zSocialFeed)),
      add: oc.input(z.strictObject({ url: z.url({ protocol: /^https?$/ }).max(2000), connectionIds: z.array(zId).min(1).max(20) })).output(z.object({ feedId: zId })),
      update: oc.input(z.strictObject({ feedId: zId, connectionIds: z.array(zId).min(1).max(20).optional(), paused: z.boolean().optional() })).output(z.object({ feedId: zId })),
      remove: oc.input(z.strictObject({ feedId: zId })).output(z.object({ feedId: zId })),
    },
    // Saved snippets (#584): members create them and change their own; owners and admins any.
    snippets: {
      list: oc.input(z.object({ provider: z.string().max(32).optional() })).output(z.array(zSocialSnippet)),
      create: oc.input(zSocialSnippetCreate).output(z.object({ snippetId: zId })),
      update: oc.input(zSocialSnippetUpdate).output(z.object({ snippetId: zId })),
      remove: oc.input(z.strictObject({ snippetId: zId })).output(z.object({ snippetId: zId })),
    },
    // Client report links (#643): owners and admins make and revoke them; the token is in the create answer only.
    reportLinks: {
      list: oc.input(z.object({})).output(z.array(zSocialReportLink)),
      create: oc.input(zSocialReportLinkCreate).output(z.object({ linkId: zId, token: z.string(), expiresAt: z.string() })),
      revoke: oc.input(z.strictObject({ linkId: zId })).output(z.object({ linkId: zId })),
    },
    // The saved brand voice for AI drafts (#741): the org's and each channel's.
    brandVoices: {
      list: oc.input(z.object({})).output(z.array(z.object({ connectionId: zId.nullable(), description: z.string(), useWords: z.array(z.string()), avoidWords: z.array(z.string()), emoji: z.boolean(), updatedAt: z.string() }))),
      save: oc
        .input(z.strictObject({ connectionId: zId.nullable().optional(), description: z.string().trim().min(1).max(600), useWords: z.array(z.string().trim().min(1).max(40)).max(20), avoidWords: z.array(z.string().trim().min(1).max(40)).max(20), emoji: z.boolean() }))
        .output(z.object({ connectionId: zId.nullable() })),
      remove: oc.input(z.strictObject({ connectionId: zId.nullable().optional() })).output(z.object({ connectionId: zId.nullable(), removed: z.boolean() })),
    },
    // Scheduled client report mail (#704): owners and admins set, pause, test and remove schedules.
    reportSchedules: {
      list: oc.input(z.object({})).output(z.array(zSocialReportSchedule)),
      save: oc.input(zSocialReportScheduleSave).output(z.object({ scheduleId: zId, nextRunAt: z.string() })),
      remove: oc.input(z.strictObject({ scheduleId: zId })).output(z.object({ scheduleId: zId })),
      test: oc.input(z.strictObject({ scheduleId: zId })).output(z.object({ runId: zId, mails: z.number().int(), suppressed: z.number().int() })),
    },
    // Link preview cards (#641): what a link's page says, read by the worker; shown in Crove only.
    linkPreviews: {
      request: oc.input(z.strictObject({ url: z.string().min(1).max(2048) })).output(zSocialLinkPreview),
      get: oc.input(z.object({ url: z.string().min(1).max(2048) })).output(zSocialLinkPreview.nullable()),
    },
    // In-app notifications (#637): each member reads, marks and turns off only their own.
    notifications: {
      list: oc.input(z.object({})).output(zSocialNotifications),
      read: oc.input(z.union([z.strictObject({ ids: z.array(zId).min(1).max(100) }), z.strictObject({ all: z.literal(true) })])).output(z.object({ read: z.number().int() })),
      mute: oc.input(z.strictObject({ kind: zSocialNotificationKind, muted: z.boolean() })).output(z.object({ kind: zSocialNotificationKind, muted: z.boolean() })),
      // The viewer's Social emails on or off (#579).
      mail: oc.input(z.strictObject({ enabled: z.boolean() })).output(z.object({ enabled: z.boolean() })),
    },
    // Account growth (#645): each channel's daily followers and reach over the last days.
    accounts: {
      trends: oc.input(z.object({ days: z.number().int().min(1).max(366) })).output(z.array(zSocialAccountTrend)),
    },
    // Posts waiting for the viewer's review (#749), for the kernel inbox: empty for members and viewers.
    reviewInbox: oc.input(z.object({})).output(
      z.object({
        items: z.array(
          z.object({
            postId: zId,
            title: z.string().nullable(),
            excerpt: z.string(),
            channels: z.array(z.object({ variantId: zId, provider: z.string(), displayName: z.string() })),
            at: z.string().nullable(),
            submittedAt: z.string(),
          }),
        ),
        total: z.number().int().min(0),
      }),
    ),
    // Client review links (#589): owners and admins make and revoke them; the token is in the create answer only.
    reviewLinks: {
      list: oc.input(z.object({ postId: zId })).output(zSocialReviewLinks),
      create: oc.input(z.strictObject({ postId: zId, days: z.number().int().min(1).max(30).optional() })).output(z.object({ linkId: zId, token: z.string(), expiresAt: z.string() })),
      revoke: oc.input(z.strictObject({ linkId: zId })).output(z.object({ linkId: zId, postId: zId })),
    },
    // The media library (S9): the org's post images, newest first, and the posts that show one.
    media: {
      list: oc
        .input(z.object({ search: z.string().trim().max(200).optional(), before: z.strictObject({ createdAt: z.iso.datetime({ offset: true }), fileId: zId }).optional(), limit: z.number().int().min(1).max(100).optional() }))
        .output(z.object({ items: z.array(zSocialLibraryItem), more: z.boolean() })),
      usage: oc.input(z.object({ fileId: zId })).output(z.array(zSocialLibraryUse)),
    },
    variants: {
      update: oc.input(zSocialVariantUpdate).output(z.object({ variantId: zId, revision: z.number().int(), changed: z.boolean() })),
      // waiting: variants approved by this reviewer that still need another person's approval (their channel's policy).
      decide: oc.input(zSocialDecide).output(z.object({ postId: zId, decision: z.string(), variants: z.array(zId), waiting: z.array(zId) })),
      schedule: oc.input(zSocialSchedule).output(z.object({ postId: zId, scheduled: z.array(z.object({ variantId: zId, at: z.string() })) })),
      unschedule: oc.input(z.strictObject({ variantIds: z.array(zId).min(1).max(20) })).output(z.object({ postId: zId, variants: z.array(zId) })),
      // Post a published channel's first comment again (#587), after a failure or an unclear answer.
      retryComment: oc.input(z.strictObject({ variantId: zId })).output(z.object({ variantId: zId })),
      // Post the rest of a published channel's thread (#742), from the first part not out.
      retryThread: oc.input(z.strictObject({ variantId: zId })).output(z.object({ variantId: zId })),
      // A scheduled variant at another time, its approvals kept (#580).
      reschedule: oc.input(z.strictObject({ variantId: zId, at: z.iso.datetime({ offset: true }) })).output(z.object({ postId: zId, variantId: zId, at: z.string() })),
      cancel: oc.input(z.strictObject({ variantIds: z.array(zId).min(1).max(20) })).output(z.object({ postId: zId, variants: z.array(zId) })),
      // Publish failed or needs_attention variants again now (a new attempt).
      retry: oc.input(z.strictObject({ variantIds: z.array(zId).min(1).max(20) })).output(z.object({ postId: zId, variants: z.array(zId) })),
      // Settle needs_attention variants: on the platform after all, or dropped.
      resolve: oc
        .input(z.strictObject({ variantIds: z.array(zId).min(1).max(20), outcome: z.enum(['published', 'dropped']), url: z.url({ protocol: /^https?$/ }).max(2000).nullable().optional() }))
        .output(z.object({ postId: zId, variants: z.array(zId), outcome: z.enum(['published', 'dropped']) })),
    },
    // Review policy per channel (S9): how many different people approve a variant before it may be scheduled.
    policies: {
      list: oc.input(z.object({})).output(z.array(z.object({ connectionId: zId, approvalsRequired: z.number().int(), reviewReminders: z.boolean(), shortLinks: z.boolean(), fourEyes: z.boolean(), updatedBy: zId, updatedAt: z.string() }))),
      set: oc
        .input(z.strictObject({ connectionId: zId, approvalsRequired: z.number().int().min(1).max(3) }))
        .output(z.object({ connectionId: zId, approvalsRequired: z.number().int(), approved: z.array(zId) })),
      // Whether the channel's reviewers are reminded of posts waiting for review (#703).
      setReminders: oc.input(z.strictObject({ connectionId: zId, reviewReminders: z.boolean() })).output(z.object({ connectionId: zId, reviewReminders: z.boolean() })),
      // Whether the channel's links go through Crove's short links, to count clicks (#706).
      setShortLinks: oc.input(z.strictObject({ connectionId: zId, shortLinks: z.boolean() })).output(z.object({ connectionId: zId, shortLinks: z.boolean() })),
      // Four-eyes (#740): owners only.
      setFourEyes: oc.input(z.strictObject({ connectionId: zId, fourEyes: z.boolean() })).output(z.object({ connectionId: zId, fourEyes: z.boolean() })),
    },
    // Variants waiting paused on each channel (expired or disconnected), for the channels screen.
    channels: {
      waiting: oc.input(z.object({})).output(z.array(z.object({ connectionId: zId, paused: z.number().int() }))),
    },
    queues: {
      get: oc.input(z.object({ connectionId: zId })).output(zSocialQueue),
      set: oc.input(zSocialQueueSet).output(z.object({ queueId: zId, moved: z.array(z.object({ variantId: zId, at: z.string().nullable() })) })),
    },
  },
  inbox: {
    list: oc.input(z.object({ status: zProposalStatus.optional() })).output(z.array(zInboxItem)),
    get: oc.input(z.object({ id: zId })).output(zInboxDetail),
    approve: oc
      .input(
        z.object({
          id: zId,
          revision: z.number().int().positive(),
          lineAccounts: z.array(z.object({ lineNo: z.number().int().positive(), debitAccount: zAccountCode })).optional(),
          note: z.string().max(500).optional(),
          acceptFailedChecks: z.boolean().optional(),
          // A purchase invoice dated in a locked month (#478): the date its journal entry is posted on, in an open month,
          // chosen by the approver. Omitted, the entry is dated on the invoice date.
          postingDate: zLocalDate.optional(),
          idempotencyKey: zId,
        }),
      )
      // A purchase returns its document, and the posting date when it was posted later than its invoice date (#478); a
      // reversal (#138) returns the entry it reversed and, when that entry recorded a purchase, the document it voided
      // (#165); a cash or bank voucher (#327) returns the voucher.
      .output(
        z.object({
          documentId: zId.optional(),
          postingDate: zLocalDate.optional(),
          journalEntryId: zId,
          reversedEntryId: zId.optional(),
          voidedDocumentId: zId.optional(),
          voucherId: zId.optional(),
        }),
      ),
    // Approves many pending proposals in one action (issue #315): owners and admins, R3 with one fresh step-up for the
    // whole batch (a stale one refuses all of it). Each item gets the same four-eyes (P10) and eligibility (P12)
    // decision and its own audit row as approving it alone; a refused item is reported with its code and the others
    // are still approved. revision: the one the caller saw in the list. At most 50 items, each once. A retry with the
    // same idempotencyKey returns the first result.
    approveMany: oc
      .input(
        z.object({
          items: zBulkApproveItems,
          idempotencyKey: zId,
        }),
      )
      .output(
        z.object({
          results: z.array(
            z.discriminatedUnion('outcome', [
              z.object({
                id: zId,
                outcome: z.literal('approved'),
                journalEntryId: zId.optional(),
                documentId: zId.optional(),
                reversedEntryId: zId.optional(),
                voidedDocumentId: zId.optional(),
                voucherId: zId.optional(),
              }),
              z.object({ id: zId, outcome: z.literal('refused'), code: z.string(), rule: z.string().nullable() }),
            ]),
          ),
        }),
      ),
    // Saves changed line accounts as a new revision authored by the caller; it never approves.
    edit: oc
      .input(
        z.object({
          id: zId,
          revision: z.number().int().positive(),
          lineAccounts: z.array(z.object({ lineNo: z.number().int().positive(), debitAccount: zAccountCode })).min(1).max(1000),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ revision: z.number().int(), changed: z.boolean() })),
    reject: oc.input(z.object({ id: zId, reason: z.string().max(500).optional() })).output(z.object({ ok: z.literal(true) })),
    // Asks for a proposal that no file produced (kernel.proposal.request; owners, admins and members): reversing a
    // posted journal entry (#138, #165), or a cash or bank voucher entered by hand (#327). It posts nothing; the
    // proposal is approved like any other (R3, P10 four-eyes, P11 step-up). Reversing a purchase entry also voids
    // Crove's record of the document on approval; approving a voucher numbers it and posts it. A retry with the same
    // idempotencyKey returns the first proposal.
    request: oc
      .input(
        z.discriminatedUnion('command', [
          z.object({ command: z.literal('finance.journal.reverse'), input: zJournalReversal, idempotencyKey: zId }),
          z.object({ command: z.literal('finance.voucher.record'), input: zCashVoucherRequest, idempotencyKey: zId }),
        ]),
      )
      .output(z.object({ proposalId: zId })),
  },
  files: {
    recent: oc.output(z.array(zFileStatus)),
    // Every role: the status of the given files of the org, in the order asked (ids it cannot see are left out), and
    // for a ZIP archive the entries it was opened into, each with its own file's status (bulk intake, #314).
    batch: oc.input(z.object({ ids: z.array(zId).min(1).max(MAX_BATCH_FILES) })).output(z.array(zBatchFile)),
    // Owners, admins and members: reads the file again (issue #40). The result is a new extraction version and,
    // when it reads an invoice, a new revision of the file's pending proposal (or a new proposal after a rejected
    // one). Refused while a run is in flight and once the invoice is booked. A retry with the same idempotencyKey
    // returns the first result.
    reextract: oc.input(z.object({ fileId: zId, idempotencyKey: zId })).output(z.object({ fileId: zId, version: z.number().int() })),
  },
  parties: {
    // Vendors by default; all: true lists customers too (the party picker of vouchers, #327).
    list: oc.input(z.object({ q: z.string().max(100).optional(), all: z.boolean().optional() })).output(z.array(zParty)),
    // Owners and admins (R1, #319): the debit account proposed first for a vendor's invoices, a TT133 account or an
    // active sub-account; null clears it (the keyword rules apply again).
    setDefaultAccount: oc
      .input(z.object({ partyId: zId, accountCode: zAccountCode.nullable() }))
      .output(z.object({ partyId: zId, accountCode: zAccountCode.nullable() })),
  },
  documents: {
    list: oc.input(z.object({ from: zLocalDate.optional(), to: zLocalDate.optional() })).output(z.array(zPurchaseDocument)),
  },
  journal: {
    list: oc.input(z.object({ from: zLocalDate.optional(), to: zLocalDate.optional() })).output(z.array(zJournalEntry)),
    // One entry, for example the one a reversal proposal names.
    get: oc.input(z.object({ id: zId })).output(zJournalEntry),
  },
  // Cash and bank vouchers (#327): the posted vouchers of a date range, newest first, VOUCHER_PAGE_SIZE at a time
  // (before: the last voucher of the page shown; more: older ones follow). A voucher is entered with inbox.request
  // (command finance.voucher.record) and posted when its proposal is approved.
  vouchers: {
    list: oc
      .input(z.object({ from: zLocalDate.optional(), to: zLocalDate.optional(), type: zVoucherType.optional(), before: zVoucherCursor.optional() }))
      .output(zCashVoucherPage),
  },
  // Opening balances from Excel (#320), owners and admins. preview checks a trial balance read from the template and
  // writes nothing; post checks it again and posts it as the org's one opening entry (R3: fresh MFA). A retry with the
  // same idempotencyKey returns the first result. To replace an opening entry, reverse it first.
  openingBalance: {
    preview: oc.input(zOpeningBalanceImport).output(zOpeningBalancePreview),
    post: oc
      .input(zOpeningBalanceImport.extend({ idempotencyKey: zId }))
      .output(z.object({ journalEntryId: zId, lines: z.number().int().positive() })),
  },
  // The org's chart: the TT133 accounts and its own sub-accounts (#319), inactive ones included (pickers hide them).
  accounts: {
    list: oc.output(z.array(zAccount)),
    // Owners and admins (R1): a sub-account under a TT133 account or a digit sub-account (11211, 1121.VCB).
    create: oc
      .input(z.object({ parentCode: zAccountCode, code: zAccountCode, name: z.string().trim().min(1).max(200) }))
      .output(z.object({ id: zId, code: zAccountCode })),
    // Owners and admins (R1): renames, deactivates or reactivates a sub-account. TT133 accounts are read-only; an
    // account stays active while it is a vendor's default or has active sub-accounts.
    update: oc
      .input(z.object({ code: zAccountCode, name: z.string().trim().min(1).max(200).optional(), active: z.boolean().optional() }))
      .output(z.object({ code: zAccountCode, name: z.string(), active: z.boolean() })),
  },
  // VAT working for one month or quarter (issue #316); the Excel file is GET /api/export/vat.xlsx?period=<period>.
  vat: {
    period: oc.input(z.object({ period: zVatPeriod })).output(zVatReport),
  },
  // The tax portal's purchase-invoice list (issue #465) for one VAT period. reconcile: every role; the lists of the
  // period and how their invoices compare with Crove's purchases. import (owners, admins, members; R1): files an .xlsx
  // uploaded with purpose 'import' as a list of the period; the worker reads it (poll reconcile until no list is
  // pending). remove (owners, admins, members; R1): takes a list out of its period; it is kept.
  portalList: {
    reconcile: oc.input(z.object({ period: zVatPeriod })).output(zPortalReconciliation),
    import: oc.input(z.object({ period: zVatPeriod, fileId: zId })).output(z.object({ listId: zId })),
    remove: oc.input(z.object({ listId: zId })).output(z.object({ listId: zId })),
  },
  // Ledger reports of a month, quarter or year (issue #321): the trial balance and the receivables and payables per
  // party, and the general ledger of one account. The Excel workbook is GET /api/export/ledger.xlsx?period=<period>.
  ledger: {
    period: oc.input(z.object({ period: zLedgerPeriod })).output(zLedgerReport),
    account: oc.input(z.object({ period: zLedgerPeriod, accountCode: zAccountCode })).output(zAccountLedger),
    // Issue #154: the DRAFT B01-DNN at the period's last day and B02-DNN for the period. The Excel workbook is
    // GET /api/export/statements.xlsx?period=<period>.
    statements: oc.input(z.object({ period: zLedgerPeriod })).output(zFinancialStatements),
  },
  // Period lock (#329): every member reads it; owners and admins lock the next month once it has ended; only owners
  // unlock the last locked month (R3: fresh MFA), with a reason. A retry with the same idempotencyKey returns the first
  // result.
  periodLock: {
    state: oc.output(zPeriodLockState),
    lock: oc.input(zPeriodLockInput.extend({ idempotencyKey: zId })).output(zPeriodLockState),
    unlock: oc.input(zPeriodUnlockInput.extend({ idempotencyKey: zId })).output(zPeriodLockState),
  },
  // Bank statements (#326): owners, admins and members import a bank's export into an account's statement lines
  // (preview writes nothing; import stores the new and ambiguous lines); every member reads them, each with its state
  // (open, proposed as a voucher, settled by one). A retry with the same
  // idempotencyKey returns the first result.
  bank: {
    preview: oc.input(zBankStatementImport).output(zBankImportPreview),
    import: oc.input(zBankStatementImport.extend({ idempotencyKey: zId })).output(zBankImportResult),
    lines: oc.input(z.object({ bankAccount: zAccountCode, period: zLedgerPeriod })).output(zBankLines),
    // The báo Có or báo Nợ a line makes and the party it is probably about (#326, stage 2a), for the voucher form; the
    // voucher itself is asked for with inbox.request (finance.voucher.record, bankLineId set). Owners, admins and
    // members, who may ask for vouchers.
    lineVoucher: oc.input(z.object({ bankLineId: zId })).output(zBankLineVoucher),
    // The open lines of an account and period whose party is named by its tax code or an invoice of the amount, with
    // the voucher each makes (stage 2b); the SPA asks for them one by one with inbox.request. Owners, admins and members.
    suggestions: oc.input(z.object({ bankAccount: zAccountCode, period: zLedgerPeriod })).output(z.array(zBankLineVoucher)),
    // The open lines per bank account, for the Inbox (stage 2b). Every member.
    openLines: oc.output(zBankOpenLines),
  },
  // The org chart (ADR-0029): positions shared by members and AI agents. Every member reads it; changing it is the
  // owner's (R3: role keys, holders and reporting lines decide what agents may do). A retry with the same
  // idempotencyKey returns the first result.
  chart: {
    get: oc.output(zChart),
    createPosition: oc
      .input(
        z.object({
          title: z.string().trim().min(1).max(200),
          module: zModuleId,
          roleKey: zAgentRoleKey,
          reportsTo: zId.nullable().optional(),
          jobDescription: zJobDescription.optional(),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ positionId: zId })),
    updatePosition: oc
      .input(
        z.object({
          id: zId,
          title: z.string().trim().min(1).max(200).optional(),
          reportsTo: zId.nullable().optional(),
          status: zPositionStatus.optional(),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ positionId: zId })),
    // Gives the position to a member or an active agent of a matching template, or vacates it (holder null).
    assign: oc
      .input(
        z.object({
          id: zId,
          holder: z.discriminatedUnion('type', [z.object({ type: z.literal('user'), userId: zId }), z.object({ type: z.literal('agent'), agentId: zId })]).nullable(),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ positionId: zId })),
    // The agent templates modules declare; moduleEnabled false means installing it answers MODULE_DISABLED.
    templates: oc.output(z.array(zAgentTemplate)),
    // Owner (R3): an agent and the position it holds, from a template. MODULE_DISABLED when the deployment does not
    // enable the template's module.
    installTemplate: oc
      .input(
        z.object({
          templateKey: z.string().min(1).max(100),
          reportsTo: zId.nullable().optional(),
          displayName: z.string().trim().min(1).max(200).optional(),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ agentId: zId, positionId: zId })),
  },
  agents: {
    // Owner (R3): status (pausing or retiring stops its runs at once), max_risk, name and daily run cap.
    update: oc
      .input(
        z.object({
          id: zId,
          status: zAgentStatus.optional(),
          maxRisk: zAgentRisk.optional(),
          displayName: z.string().trim().min(1).max(200).optional(),
          dailyRunCap: z.number().int().min(1).max(10000).optional(),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ agentId: zId })),
    // Owners and admins: the monthly budgets and this month's spend.
    budgets: oc.output(z.array(zAgentBudget)),
    // Owner (R3): sets the monthly budget of the org (target '*'), a module or an agent.
    setBudget: oc
      .input(
        z.object({
          scope: zAgentScope,
          target: z.string().min(1).max(100),
          monthlyLimit: zAiAmount,
          warnPercent: z.number().int().min(1).max(100).optional(),
          hardStop: z.boolean().optional(),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ budgetId: zId })),
    // "Stop AI": owners and admins, R1, so it never waits for a second factor. Engaging a switch that is already on
    // is a no-op that returns it.
    stop: oc
      .input(z.object({ scope: zAgentScope, target: z.string().min(1).max(100), reason: z.string().max(500).optional(), idempotencyKey: zId }))
      .output(z.object({ killSwitchId: zId, stoppedRuns: z.number().int() })),
    // Owner (R3, fresh MFA): turns a kill switch off again.
    release: oc.input(z.object({ id: zId, idempotencyKey: zId })).output(z.object({ ok: z.literal(true) })),
  },
  // Work given to positions, held by members or agents (ADR-0029). Every member reads; owners, admins and members
  // create, comment and change status.
  tasks: {
    list: oc.input(z.object({ positionId: zId.optional(), mine: z.boolean().optional(), status: z.array(zTaskStatus).max(6).optional() })).output(z.array(zTask)),
    get: oc.input(z.object({ id: zId })).output(zTaskDetail),
    create: oc
      .input(
        z.object({
          title: z.string().trim().min(1).max(300),
          description: z.string().max(10000).optional(),
          assigneePositionId: zId.nullable(),
          due: z.iso.datetime().optional(),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ taskId: zId })),
    comment: oc.input(z.object({ id: zId, body: z.string().trim().min(1).max(10000), idempotencyKey: zId })).output(z.object({ commentId: zId })),
    setStatus: oc.input(z.object({ id: zId, status: zTaskStatus, idempotencyKey: zId })).output(z.object({ taskId: zId, status: zTaskStatus })),
  },
};

export type Contract = typeof contract;
