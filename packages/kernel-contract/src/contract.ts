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
  zSocialBulkAssign,
  zSocialBulkLabels,
  zSocialBulkResult,
  zSocialDecide,
  zSocialPost,
  zSocialRecurrence,
  zSocialReviewDiff,
  zSocialPostVersions,
  zSocialPostCreate,
  zSocialPostUpdate,
  zSocialQueue,
  zSocialMetricsRow,
  zSocialExternalPost,
  zSocialPlanRow,
  zSocialTeamReport,
  zSocialWindowTotals,
  zSocialChannelInsights,
  zSocialBioPage,
  zSocialBioSave,
  zSocialFeed,
  zSocialIdea,
  zSocialIdeaCreate,
  zSocialIdeaUpdate,
  zSocialLibraryItem,
  zSocialLibraryUse,
  zSocialMediaTagCount,
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
  zSocialReportBrand,
  zSocialReportBrandingSave,
  zSocialLabel,
  zSocialLabelCreate,
  zSocialLabelUpdate,
  zSocialReviewLinks,
  zSocialReviewPlanCreate,
  zSocialReviewPlanLink,
  zSocialActivityItem,
  zSocialQueueSet,
  zSocialQueueShuffle,
  zSocialQueueMoveToFront,
  zSocialQueueReorder,
  zSocialSchedule,
  zSocialVariantUpdate,
  zSocialChannelInput,
  SOCIAL_LABEL_COLORS,
  SOCIAL_WATERMARK_CORNERS,
  SOCIAL_CHAT_ALERT_KINDS,
  SOCIAL_CHAT_ALERT_TARGETS,
  SOCIAL_POST_STATUSES,
  SOCIAL_VARIANT_STATUSES,
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
  zCustomerCursor,
  zCustomerPage,
  zDuplicateHint,
  zProposalStatus,
  zPurchaseDocument,
  zDocumentExport,
  zSearchResult,
  zNotificationKind,
  zNotifications,
  zRole,
  zSession,
  zSessionRevoke,
  zVatPeriod,
  zVatFilingPeriod,
  zVatReport,
  zExchangeRate,
  zInputVatCheckOutcome,
  zAccountLedger,
  zFinancialStatements,
  zLedgerPeriod,
  zLedgerReport,
  zPeriodLockInput,
  zPeriodLockState,
  zArchiveYear,
  zYearArchive,
  zYearArchives,
  zPeriodUnlockInput,
  zTaxRegistryEntry,
  zVoucherType,
} from './schemas.ts';
import { zCashVoucherPage, zCashVoucherRequest, zVoucherCursor } from './cash-voucher.ts';
import { zDepreciationRequest, zJournalVoucherRequest, zYearClosingRequest } from './journal-voucher.ts';
import { zFixedAsset, zFixedAssetCreate, zFixedAssetEnd } from './fixed-asset.ts';
import { zStatementsHtkkCheck, zStatementsHtkkYear } from './statements-htkk.ts';
import { zTaxObligationMark, zTaxProfile } from './tax-calendar.ts';
import { zOpeningBalanceImport, zOpeningBalancePreview } from './opening-balance.ts';
import { MISSING_INVOICE_REMINDER_DAY_MAX, zMissingInvoiceStatus, zPortalReconciliation } from './portal-list.ts';
import { zBankImportPreview, zBankImportResult, zBankLineVoucher, zBankLines, zBankOpenLines, zBankStatementImport } from './bank-statement.ts';
import { zTimeline } from './timeline.ts';
import { zAuditCursor, zAuditExport, zAuditFilter, zAuditPage } from './audit.ts';
import { zPersonalDataErasure, zPersonalDataQuery, zPersonalDataResult } from './personal-data.ts';

// Proposal reminders (issue #676): days before the approvers are reminded and before the owners are told; and expiry
// (#876): days after which a proposal still pending expires. Expiry needs the escalation and comes after it.
export const zProposalPolicy = z.object({
  remindAfterDays: z.number().int().min(1).max(30).nullable(),
  escalateAfterDays: z.number().int().min(1).max(60).nullable(),
  expireAfterDays: z.number().int().min(2).max(90).nullable(),
});

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
    // Owners and admins (issue #669): the org's contact email, where its own mail goes (a request for missing invoices),
    // or null to clear it.
    setContactEmail: oc.input(z.object({ email: z.email().max(320).nullable() })).output(z.object({ contactEmail: z.string().nullable() })),
    // Everyone reads, owners and admins set (issue #676): after how many days a pending proposal reminds the people who
    // may approve it, and after how many its owners are told; null turns either off. Escalation must come later.
    proposalPolicy: oc.output(zProposalPolicy),
    setProposalPolicy: oc.input(zProposalPolicy).output(zProposalPolicy),
    // The tax calendar (issue #921): everyone reads which obligations apply, owners and admins set them; owners, admins
    // and members mark an obligation done for a period (or take the mark back), which removes it from the home screen.
    taxProfile: oc.output(zTaxProfile.extend({ since: zLocalDate.nullable() })),
    setTaxProfile: oc.input(zTaxProfile).output(zTaxProfile.extend({ since: zLocalDate.nullable() })),
    markTaxObligation: oc.input(zTaxObligationMark.extend({ done: z.boolean() })).output(zTaxObligationMark.extend({ done: z.boolean() })),
    // Owners and admins (issue #672): the org's audit log, newest first, filtered and paged; the commands it holds, for
    // the filter; and the filtered list as a CSV file (the export leaves its own audit row).
    audit: oc.input(zAuditFilter.extend({ before: zAuditCursor.optional() })).output(zAuditPage),
    auditCommands: oc.output(z.array(z.string())),
    auditExport: oc.input(zAuditFilter).output(zAuditExport),
    // Owners and admins (issue #923, PDPL): every row of the org that holds a person's email, phone, or tax code or
    // national ID, with what an erasure would do to each, for the person's request to see or export their data.
    personalData: oc.input(zPersonalDataQuery).output(zPersonalDataResult),
    // Owners only (issue #923). R3: needs fresh MFA. Erases the person's data the finder shows as "erase" and lists
    // what it kept and why. A retry with the same idempotencyKey returns the first result.
    personalDataErase: oc.input(zPersonalDataQuery.extend({ idempotencyKey: zId })).output(zPersonalDataErasure),
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
    // A Mastodon account (#748): the instance's address and an access token made in its settings. The server checks the
    // token with the instance through the egress guard, then seals it.
    connectMastodon: oc
      .input(z.object({ instance: z.string().trim().min(1).max(260), accessToken: z.string().trim().min(1).max(300) }))
      .output(z.object({ connectionId: zId, reconnected: z.boolean() })),
    // A WordPress site (#833): its address (https, with the path WordPress lives under, if any), a user name and an
    // application password from that user's profile. The server checks the user may publish, through the egress guard,
    // then seals the password; the formats are checked by the server, in words.
    connectWordPress: oc
      .input(z.object({ site: z.string().trim().min(1).max(300), username: z.string().trim().min(1).max(100), appPassword: z.string().trim().min(1).max(100) }))
      .output(z.object({ connectionId: zId, reconnected: z.boolean() })),
    connectTelegram: oc
      .input(z.object({ botToken: z.string().trim().min(1).max(100), channel: z.string().trim().min(1).max(100) }))
      .output(z.object({ connectionId: zId, reconnected: z.boolean() })),
    // A Discord channel (#832): the URL of a webhook a server admin made in the channel's settings. The server checks the
    // webhook with Discord, then seals its token; the format is checked by the server, in words.
    connectDiscord: oc
      .input(z.object({ webhookUrl: z.string().trim().min(1).max(300) }))
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
      // Per channel, the content of its last review decision next to its content now (#944), for the review panel's diff.
      reviewDiff: oc.input(z.strictObject({ postId: zId })).output(zSocialReviewDiff),
      // The post's saved versions, newest first (#1021), at most 50.
      versions: oc.input(z.strictObject({ postId: zId })).output(zSocialPostVersions),
      // Saves a version again as a new edit (#1021): changed channels go back to draft; channels that are history keep
      // their content (kept), and a post with no channel left to edit is refused.
      restoreVersion: oc
        .input(
          z.strictObject({
            postId: zId,
            versionId: zId,
            revision: z.number().int().positive(),
            // Each channel's revision as the page shows it; a channel edited since refuses the restore.
            variantRevisions: z.record(zId, z.number().int().positive()).optional(),
          }),
        )
        .output(z.object({ postId: zId, revision: z.number().int(), changedVariants: z.array(zId), kept: z.array(zId) })),
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
      // Labels added to and taken off up to 100 posts at once (#1057); the answer names each post left out and why.
      bulkLabels: oc.input(zSocialBulkLabels).output(zSocialBulkResult),
      // The assignee, and optionally the due date, of up to 100 posts at once (#1057), with the same answer.
      bulkAssign: oc.input(zSocialBulkAssign).output(zSocialBulkResult),
      // A copy of any post as a new draft, for the channels still connected (#575).
      duplicate: oc.input(z.strictObject({ postId: zId })).output(z.object({ postId: zId })),
      // Repost a published post every N days (7 to 365), each repost sent to review; null stops it.
      setEvergreen: oc.input(z.strictObject({ postId: zId, days: z.number().int().min(7).max(365).nullable() })).output(z.object({ postId: zId, evergreenDays: z.number().int().nullable() })),
      // Repeat a post on fixed weekdays at a local time (#979): after each publish the worker makes the next copy, planned
      // for its occurrence and sent to review. Setting it makes the post a series; clearing it ends the series.
      setRecurrence: oc.input(z.strictObject({ postId: zId, recurrence: zSocialRecurrence })).output(z.object({ postId: zId, recurrence: zSocialRecurrence })),
      clearRecurrence: oc.input(z.strictObject({ postId: zId })).output(z.object({ postId: zId })),
      // AI drafting (Social plan §3.7): the server asks the deployment's model for a draft from the brief and saves it as
      // a new post with origin 'ai' (tainted), one variant per channel. Each call drafts anew: a draft whose answer was
      // lost is only an extra draft, which publishes nothing until a person approves it.
      draftWithAi: oc
        .input(
          z.strictObject({
            brief: z.string().trim().max(4000),
            connectionIds: z.array(zId).min(1).max(20),
            tone: z.string().trim().max(300).optional(),
            language: z.enum(['vi', 'en']).optional(),
            // A page to write about (#769): read through its link preview, and the post links to it.
            sourceUrl: z
              .url({ protocol: /^https?$/ })
              .max(2000)
              .refine((u) => !/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(u), 'a link without a user name or password')
              .optional(),
          })
          .refine((v) => v.brief.length > 0 || v.sourceUrl !== undefined, { message: 'a brief or a source page', path: ['brief'] }),
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
      // Hashtags the writer suggests for a text (#824), tainted like every AI text; the same budget as drafts.
      // An image's alt text the writer suggests (#817), when the model takes images; the same budget as drafts.
      describeImage: oc.input(z.strictObject({ fileId: zId, language: z.enum(['vi', 'en']) })).output(z.object({ altText: z.string() })),
      suggestHashtags: oc
        .input(z.strictObject({ text: z.string().trim().min(1).max(20_000), connectionId: zId.optional(), language: z.enum(['vi', 'en']), exclude: z.array(z.string().max(100)).max(50) }))
        .output(z.object({ hashtags: z.array(z.string()) })),
    },
    // How published posts did (S8): the latest capture of each variant published in the last days days (30 by default).
    metrics: {
      // postId: that post's published channels, whenever they went out.
      // labelId: only posts with that label (#639).
      summary: oc.input(z.object({ days: z.number().int().min(1).max(365).optional(), postId: zId.optional(), labelId: zId.optional() })).output(z.array(zSocialMetricsRow)),
      // The window's totals over every published channel (#397), summed by the server, and per channel; previous: the
      // same for the window of the same length just before (#947).
      // includeExternal (#1054): with the posts each channel published outside Crove (none under a label filter).
      totals: oc
        .input(z.object({ days: z.number().int().min(1).max(365).optional(), labelId: zId.optional(), includeExternal: z.boolean().optional() }))
        .output(zSocialWindowTotals.extend({ previous: zSocialWindowTotals })),
      // The posts the channels published outside Crove in the window (#1054), newest first, with their latest counts.
      external: oc.input(z.object({ days: z.number().int().min(1).max(365).optional() })).output(z.array(zSocialExternalPost)),
      // What works (#705): each channel's posts against its own median, by label, format, weekday, hour and hashtag.
      insights: oc
        .input(z.object({ days: z.number().int().min(1).max(365), labelId: zId.optional(), timeZone: z.string().min(1).max(64) }))
        .output(z.object({ channels: z.array(zSocialChannelInsights), truncated: z.boolean() })),
      // The window as a CSV file (UTF-8 with a byte order mark); every export is audited.
      export: oc
        .input(z.strictObject({ days: z.number().int().min(1).max(365), labelId: zId.optional() }))
        .output(z.object({ filename: z.string(), csv: z.string(), truncated: z.boolean() })),
    },
    // The content plan for a client (#978): the channel posts of [from, to), at most 92 days, as a CSV file whose first
    // columns re-import as drafts (format csv) or as rows for the print layout (format print), at most 500 of them.
    // Members and above; every export is audited.
    plan: {
      export: oc
        .input(
          z.strictObject({
            from: z.iso.datetime({ offset: true }),
            to: z.iso.datetime({ offset: true }),
            timeZone: z.string().min(1).max(64),
            connectionIds: z.array(zId).min(1).max(50).optional(),
            labelIds: z.array(zId).min(1).max(20).optional(),
            format: z.enum(['csv', 'print']).optional(),
          }),
        )
        .output(z.object({ filename: z.string(), csv: z.string().nullable(), rows: z.array(zSocialPlanRow).nullable(), truncated: z.boolean() })),
    },
    // The team report (#1058), owners and admins only, over [from, to) of at most 366 days: per member, posts created,
    // sent to review, approved, published, assigned with a due date and overdue, and review decisions with the median
    // time from submission to decision; for client review links, the median time to the client's answer.
    team: {
      report: oc.input(z.strictObject({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) })).output(zSocialTeamReport),
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
    // Saved sets of channels for the composer (#774): owners and admins save and remove them; everyone reads.
    channelSets: {
      list: oc.input(z.object({})).output(z.array(z.object({ id: zId, name: z.string(), connectionIds: z.array(zId), updatedAt: z.string() }))),
      save: oc.input(z.strictObject({ setId: zId.optional(), name: z.string().trim().min(1).max(80), connectionIds: z.array(zId).min(1).max(20) })).output(z.object({ setId: zId })),
      remove: oc.input(z.strictObject({ setId: zId })).output(z.object({ setId: zId, removed: z.boolean() })),
    },
    // The posting calendar feed (#862): owners and admins make (replacing the live one) and revoke it; the token is in
    // the create answer only. Everyone sees whether there is one.
    calendarFeed: {
      get: oc.input(z.object({})).output(z.object({ createdAt: z.string(), createdBy: zId }).nullable()),
      create: oc.input(z.strictObject({})).output(z.object({ token: z.string() })),
      revoke: oc.input(z.strictObject({})).output(z.object({ revoked: z.boolean() })),
    },
    // Notes on calendar dates (#794): owners, admins and members save and remove them; everyone reads the ones that
    // overlap the days shown.
    calendarNotes: {
      list: oc
        .input(z.strictObject({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
        .output(z.array(z.object({ id: zId, startsOn: z.string(), endsOn: z.string(), title: z.string(), color: z.enum(SOCIAL_LABEL_COLORS), updatedBy: zId, updatedAt: z.string() }))),
      save: oc
        .input(
          z.strictObject({
            noteId: zId.optional(),
            startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            title: z.string().trim().min(1).max(120),
            color: z.enum(SOCIAL_LABEL_COLORS).optional(),
          }),
        )
        .output(z.object({ noteId: zId })),
      remove: oc.input(z.strictObject({ noteId: zId })).output(z.object({ noteId: zId, removed: z.boolean() })),
    },
    // The saved brand voice for AI drafts (#741): the org's and each channel's.
    brandVoices: {
      list: oc.input(z.object({})).output(z.array(z.object({ connectionId: zId.nullable(), description: z.string(), useWords: z.array(z.string()), avoidWords: z.array(z.string()), emoji: z.boolean(), updatedAt: z.string() }))),
      save: oc
        .input(z.strictObject({ connectionId: zId.nullable().optional(), description: z.string().trim().min(1).max(600), useWords: z.array(z.string().trim().min(1).max(40)).max(20), avoidWords: z.array(z.string().trim().min(1).max(40)).max(20), emoji: z.boolean() }))
        .output(z.object({ connectionId: zId.nullable() })),
      remove: oc.input(z.strictObject({ connectionId: zId.nullable().optional() })).output(z.object({ connectionId: zId.nullable(), removed: z.boolean() })),
    },
    // The org's logo watermark for post images (#834): the composer draws it on a copy of an image.
    watermark: {
      get: oc.input(z.object({})).output(z.object({ fileId: zId, mime: z.string(), corner: z.enum(SOCIAL_WATERMARK_CORNERS), scalePercent: z.number().int(), opacityPercent: z.number().int(), updatedAt: z.string() }).nullable()),
      save: oc
        .input(z.strictObject({ fileId: zId, corner: z.enum(SOCIAL_WATERMARK_CORNERS), scalePercent: z.number().int().min(5).max(50), opacityPercent: z.number().int().min(10).max(100) }))
        .output(z.object({ saved: z.boolean() })),
      remove: oc.input(z.strictObject({})).output(z.object({ removed: z.boolean() })),
    },
    // White-label client reports (#1053): every member reads the org's report branding; owners and admins save and
    // remove it. The logo is a data URL the browser made; the command checks its type, magic number and size.
    reportBranding: {
      get: oc.input(z.object({})).output(zSocialReportBrand.extend({ updatedAt: z.string() }).nullable()),
      save: oc.input(zSocialReportBrandingSave).output(z.object({ saved: z.boolean() })),
      remove: oc.input(z.strictObject({})).output(z.object({ removed: z.boolean() })),
    },
    // A hold on all of the org's publishing (#946), for a crisis or a mourning day: owners and admins put it on with a
    // reason and take it off; every member reads who put it on, when and why.
    publishing: {
      get: oc
        .input(z.object({}))
        .output(z.object({ held: z.boolean(), hold: z.object({ id: zId, reason: z.string(), heldBy: zId, heldByName: z.string().nullable(), heldAt: z.string() }).nullable() })),
      hold: oc.input(z.strictObject({ reason: z.string().trim().min(1).max(500) })).output(z.object({ holdId: zId, heldAt: z.string(), created: z.boolean() })),
      release: oc.input(z.strictObject({})).output(z.object({ released: z.boolean(), heldTooLong: z.number().int() })),
    },
    // The org's team chat for Social alerts (#863): a Telegram chat (bot token and chat) or a Discord webhook, and the
    // kinds of alert it gets. The server checks the target with the platform and seals it; no answer carries it back.
    chatAlert: {
      get: oc
        .input(z.object({}))
        .output(
          z
            .object({
              kind: z.enum(SOCIAL_CHAT_ALERT_TARGETS),
              events: z.array(z.enum(SOCIAL_CHAT_ALERT_KINDS)),
              label: z.string().nullable(),
              updatedAt: z.string(),
              // The last test line: when the worker tried it, and the code of why it did not go out (null: it did).
              lastTestAt: z.string().nullable(),
              lastTestCode: z.string().nullable(),
            })
            .nullable(),
        ),
      save: oc
        .input(
          z.discriminatedUnion('kind', [
            z.strictObject({ kind: z.literal('telegram'), botToken: z.string().trim().min(1).max(100), chatId: z.string().trim().min(1).max(100), events: z.array(z.enum(SOCIAL_CHAT_ALERT_KINDS)).min(1).max(4) }),
            z.strictObject({ kind: z.literal('discord'), webhookUrl: z.string().trim().min(1).max(300), events: z.array(z.enum(SOCIAL_CHAT_ALERT_KINDS)).min(1).max(4) }),
          ]),
        )
        .output(z.object({ saved: z.boolean() })),
      remove: oc.input(z.strictObject({})).output(z.object({ removed: z.boolean() })),
      // Asks the worker for one test line to the saved chat now; its outcome shows in get (lastTestAt, lastTestCode).
      test: oc.input(z.strictObject({})).output(z.object({ queued: z.boolean() })),
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
    // Channels and posts that need a person (#771), for the kernel inbox: empty for members and viewers.
    attentionInbox: oc.input(z.object({})).output(
      z.object({
        channels: z.array(z.object({ connectionId: zId, provider: z.string(), displayName: z.string(), status: z.enum(['expired', 'error']) })),
        posts: z.array(
          z.object({
            postId: zId,
            excerpt: z.string(),
            channels: z.array(z.object({ variantId: zId, provider: z.string(), displayName: z.string(), status: z.string(), errorCode: z.string().nullable() })),
            updatedAt: z.string(),
          }),
        ),
        total: z.number().int().min(0),
      }),
    ),
    // Client review links (#589): owners and admins make and revoke them; the token is in the create answer only.
    reviewLinks: {
      list: oc.input(z.object({ postId: zId })).output(zSocialReviewLinks),
      create: oc.input(z.strictObject({ postId: zId, days: z.number().int().min(1).max(30).optional() })).output(z.object({ linkId: zId, token: z.string(), expiresAt: z.string() })),
      // A plan link (#902): one link for several posts, answered one by one; the token is in this answer only.
      createPlan: oc.input(zSocialReviewPlanCreate).output(z.object({ linkId: zId, token: z.string(), expiresAt: z.string(), posts: z.number().int().min(1) })),
      plans: oc.input(z.object({})).output(z.array(zSocialReviewPlanLink)),
      // postId is null for a plan link.
      revoke: oc.input(z.strictObject({ linkId: zId })).output(z.object({ linkId: zId, postId: zId.nullable() })),
    },
    // The media library (S9): the org's post images, newest first, and the posts that show one. Members tag files and
    // the list filters by one tag, whatever its case (#904); tags lists the org's tags for the filter.
    media: {
      list: oc
        .input(
          z.object({
            search: z.string().trim().max(200).optional(),
            tag: z.string().max(200).optional(),
            before: z.strictObject({ createdAt: z.iso.datetime({ offset: true }), fileId: zId }).optional(),
            limit: z.number().int().min(1).max(100).optional(),
          }),
        )
        .output(z.object({ items: z.array(zSocialLibraryItem), more: z.boolean() })),
      usage: oc.input(z.object({ fileId: zId })).output(z.array(zSocialLibraryUse)),
      tags: oc.input(z.object({})).output(z.array(zSocialMediaTagCount)),
      tag: oc.input(z.strictObject({ fileId: zId, tags: z.array(z.string().max(200)).min(1).max(20) })).output(z.object({ fileId: zId, tags: z.array(z.string()) })),
      untag: oc.input(z.strictObject({ fileId: zId, tags: z.array(z.string().max(200)).min(1).max(20) })).output(z.object({ fileId: zId, tags: z.array(z.string()) })),
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
      // Take a published channel down from its platform (#860), owners and admins, with an optional reason. The worker
      // makes the call; queued false: an earlier ask is still on its way, or it is removed already.
      remove: oc
        .input(z.strictObject({ variantId: zId, reason: z.string().trim().max(500).optional() }))
        .output(z.object({ postId: zId, variantId: zId, status: z.enum(SOCIAL_VARIANT_STATUSES), queued: z.boolean() })),
      // Settle needs_attention variants: on the platform after all, or dropped.
      resolve: oc
        .input(z.strictObject({ variantIds: z.array(zId).min(1).max(20), outcome: z.enum(['published', 'dropped']), url: z.url({ protocol: /^https?$/ }).max(2000).nullable().optional() }))
        .output(z.object({ postId: zId, variants: z.array(zId), outcome: z.enum(['published', 'dropped']) })),
    },
    // Review policy per channel (S9): how many different people approve a variant before it may be scheduled.
    policies: {
      list: oc.input(z.object({})).output(z.array(z.object({ connectionId: zId, approvalsRequired: z.number().int(), reviewReminders: z.boolean(), shortLinks: z.boolean(), fourEyes: z.boolean(), clientApproval: z.boolean(), updatedBy: zId, updatedAt: z.string() }))),
      set: oc
        .input(z.strictObject({ connectionId: zId, approvalsRequired: z.number().int().min(1).max(3) }))
        .output(z.object({ connectionId: zId, approvalsRequired: z.number().int(), approved: z.array(zId) })),
      // Whether the channel's reviewers are reminded of posts waiting for review (#703).
      setReminders: oc.input(z.strictObject({ connectionId: zId, reviewReminders: z.boolean() })).output(z.object({ connectionId: zId, reviewReminders: z.boolean() })),
      // Whether the channel's links go through Crove's short links, to count clicks (#706).
      setShortLinks: oc.input(z.strictObject({ connectionId: zId, shortLinks: z.boolean() })).output(z.object({ connectionId: zId, shortLinks: z.boolean() })),
      // Four-eyes (#740): owners only.
      setFourEyes: oc.input(z.strictObject({ connectionId: zId, fourEyes: z.boolean() })).output(z.object({ connectionId: zId, fourEyes: z.boolean() })),
      // The client's approval on a review link as a review step (#770): owners only.
      setClientApproval: oc.input(z.strictObject({ connectionId: zId, clientApproval: z.boolean() })).output(z.object({ connectionId: zId, clientApproval: z.boolean(), approved: z.array(zId) })),
    },
    // Variants waiting paused on each channel (expired or disconnected), for the channels screen.
    channels: {
      waiting: oc.input(z.object({})).output(z.array(z.object({ connectionId: zId, paused: z.number().int() }))),
    },
    queues: {
      get: oc.input(z.object({ connectionId: zId })).output(zSocialQueue),
      set: oc.input(zSocialQueueSet).output(z.object({ queueId: zId, moved: z.array(z.object({ variantId: zId, at: z.string().nullable() })) })),
      // Reordering (#1020), owners and admins: only queued posts that may move trade their slot times.
      shuffle: oc.input(zSocialQueueShuffle).output(zSocialQueueReorder),
      moveToFront: oc.input(zSocialQueueMoveToFront).output(zSocialQueueReorder),
    },
  },
  inbox: {
    list: oc.input(z.object({ status: zProposalStatus.optional() })).output(z.array(zInboxItem)),
    get: oc.input(z.object({ id: zId })).output(zInboxDetail),
    // Every member who can open the proposal (issue #672): what happened to it, its file and the records it touched.
    timeline: oc.input(z.object({ id: zId })).output(zTimeline),
    approve: oc
      .input(
        z.object({
          id: zId,
          revision: z.number().int().positive(),
          lineAccounts: z.array(z.object({ lineNo: z.number().int().positive(), debitAccount: zAccountCode })).optional(),
          note: z.string().max(500).optional(),
          acceptFailedChecks: z.boolean().optional(),
          // The approver confirmed this revision of an invoice whose digital signature is unverified (#674); required for one.
          acceptUnverifiedSignature: z.boolean().optional(),
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
    // Saves changed line accounts, or the exchange rate of a foreign-currency invoice read without one (#918), as a new
    // revision authored by the caller (who then cannot approve it, P10); it never approves. RATE_NOT_EDITABLE (422):
    // the invoice is in VND or already has its rate.
    edit: oc
      .input(
        z.object({
          id: zId,
          revision: z.number().int().positive(),
          lineAccounts: z.array(z.object({ lineNo: z.number().int().positive(), debitAccount: zAccountCode })).min(1).max(1000).optional(),
          exchangeRate: zExchangeRate.optional(),
          idempotencyKey: zId,
        }),
      )
      .output(z.object({ revision: z.number().int(), changed: z.boolean() })),
    reject: oc.input(z.object({ id: zId, reason: z.string().max(500).optional() })).output(z.object({ ok: z.literal(true) })),
    // Asks again for a proposal that expired (#876; owners, admins and members who wrote it): a new pending proposal from
    // the same source, approved like any other. A retry with the same idempotencyKey returns the first one.
    resubmit: oc.input(z.object({ id: zId, idempotencyKey: zId })).output(z.object({ proposalId: zId })),
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
          // A general journal voucher (NVK, #888) entered by hand.
          z.object({ command: z.literal('finance.journal_voucher.record'), input: zJournalVoucherRequest, idempotencyKey: zId }),
          // The year-end closing (#889): the server builds the lines from the ledger.
          z.object({ command: z.literal('finance.closing.record'), input: zYearClosingRequest, idempotencyKey: zId }),
          // A month's depreciation and allocation (#919): the server builds the lines from the register.
          z.object({ command: z.literal('finance.depreciation.record'), input: zDepreciationRequest, idempotencyKey: zId }),
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
    // Every role (#670): the customers, by name, a page at a time (after: the last customer shown; more: others
    // follow), each with its receivable on 131 and its last invoice date. q searches the name and the tax code.
    customers: oc.input(z.object({ q: z.string().max(100).optional(), after: zCustomerCursor.optional() })).output(zCustomerPage),
    // Owners, admins and members (R1, #887): the party's name and contact details, from the version the editor read.
    // A tax code can be added, never changed or removed.
    update: oc
      .input(
        z.object({
          partyId: zId,
          version: z.number().int().min(1),
          name: z.string().max(1000),
          taxCode: z.string().max(40).nullable(),
          address: z.string().max(2000).nullable(),
          email: z.string().max(1000).nullable(),
          phone: z.string().max(100).nullable(),
        }),
      )
      .output(z.object({ partyId: zId, version: z.number().int() })),
    // Owners and admins (R1, #887): partyId becomes a duplicate of keepId, hidden from lists and search and reported
    // under it; nothing is deleted. unmarkDuplicate undoes it.
    markDuplicate: oc.input(z.object({ partyId: zId, keepId: zId })).output(z.object({ partyId: zId, keepId: zId })),
    unmarkDuplicate: oc.input(z.object({ partyId: zId })).output(z.object({ partyId: zId })),
    // Owners, admins and members: pairs of parties that look like duplicates, strongest first.
    duplicateHints: oc.input(z.object({})).output(z.array(zDuplicateHint)),
  },
  documents: {
    list: oc.input(z.object({ from: zLocalDate.optional(), to: zLocalDate.optional() })).output(z.array(zPurchaseDocument)),
    // Every role (issue #878): the exports a recorded document went out in, for its history.
    exports: oc.input(z.object({ documentId: zId })).output(z.array(zDocumentExport)),
  },
  // In-app notifications of the kernel and finance (#671): each member reads, marks and turns off only their own.
  notifications: {
    list: oc.input(z.object({})).output(zNotifications),
    read: oc.input(z.union([z.strictObject({ ids: z.array(zId).min(1).max(100) }), z.strictObject({ all: z.literal(true) })])).output(z.object({ read: z.number().int() })),
    mute: oc.input(z.strictObject({ kind: zNotificationKind, muted: z.boolean() })).output(z.object({ kind: zNotificationKind, muted: z.boolean() })),
  },
  // Every role (#673): parties by name or tax code, documents by series, number or party, journal entries by
  // description or amount. Vietnamese marks and case are ignored, and each word matches the start of a word.
  search: {
    query: oc.input(z.object({ q: z.string().trim().min(2).max(100) })).output(zSearchResult),
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
  // markPayment (owners, admins, members; R1, audited; #917): the accountant's mark on an input invoice of the period
  // that needs proof of non-cash payment: paid_by_bank (optionally with the bank voucher, báo Nợ, that paid it),
  // not_deductible, or cleared. NOT_FLAGGED (409) when the invoice does not need the check; VOUCHER_NOT_BANK (422)
  // when the voucher is not a báo Nợ of the org.
  vat: {
    period: oc.input(z.object({ period: zVatPeriod })).output(zVatReport),
    markPayment: oc
      .input(
        z.object({
          documentId: zId,
          outcome: zInputVatCheckOutcome,
          voucherId: zId.nullable().optional(),
          note: z.string().trim().min(1).max(500).nullable().optional(),
        }),
      )
      .output(z.object({ documentId: zId, outcome: zInputVatCheckOutcome })),
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
  // Asking the client company for the purchase invoices the portal lists and Crove lacks (issue #669). status: every
  // role. request (owners, admins, members; R1): one mail listing a period's missing invoices to the org's contact email,
  // queued and sent by the worker; CONTACT_EMAIL_REQUIRED (409) without a contact email, NOTHING_MISSING (409),
  // REQUEST_TOO_SOON (409) within an hour of the last request for the period; status 'suppressed' when the org stopped
  // mail to the address. setReminder (owners, admins, members; R1): the day of the month of the reminder, or null.
  missingInvoices: {
    status: oc.output(zMissingInvoiceStatus),
    request: oc
      .input(z.object({ period: zVatPeriod }))
      .output(z.object({ messageId: zId, status: z.enum(['queued', 'suppressed']), count: z.number().int().positive() })),
    setReminder: oc
      .input(z.object({ day: z.number().int().min(1).max(MISSING_INVOICE_REMINDER_DAY_MAX).nullable() }))
      .output(z.object({ day: z.number().int().min(1).max(MISSING_INVOICE_REMINDER_DAY_MAX).nullable() })),
  },
  // Ledger reports of a month, quarter or year (issue #321): the trial balance and the receivables and payables per
  // party, and the general ledger of one account. The Excel workbook is GET /api/export/ledger.xlsx?period=<period>.
  ledger: {
    period: oc.input(z.object({ period: zLedgerPeriod })).output(zLedgerReport),
    account: oc.input(z.object({ period: zLedgerPeriod, accountCode: zAccountCode })).output(zAccountLedger),
    // Issue #154: the DRAFT B01-DNN at the period's last day and B02-DNN for the period. The Excel workbook is
    // GET /api/export/statements.xlsx?period=<period>.
    statements: oc.input(z.object({ period: zLedgerPeriod })).output(zFinancialStatements),
    // Issue #920: what the HTKK XML of a year's statements (GET /api/export/statements-htkk.xml?year=<year>) would get
    // wrong or leave out, for the screen to say before the download.
    statementsHtkkCheck: oc.input(z.object({ year: zStatementsHtkkYear })).output(zStatementsHtkkCheck),
  },
  // Period lock (#329): every member reads it; owners and admins lock the next month once it has ended; only owners
  // unlock the last locked month (R3: fresh MFA), with a reason. A retry with the same idempotencyKey returns the first
  // result.
  periodLock: {
    state: oc.output(zPeriodLockState),
    lock: oc.input(zPeriodLockInput.extend({ idempotencyKey: zId })).output(zPeriodLockState),
    unlock: oc.input(zPeriodUnlockInput.extend({ idempotencyKey: zId })).output(zPeriodLockState),
  },
  // The register of fixed assets and prepaid costs (#919): every member reads it with what each asset has posted and
  // what is left; owners, admins and members add an entry (from an approved purchase line or by hand) and stop one
  // early. A month's depreciation is asked for with inbox.request (finance.depreciation.record). The Excel workbook is
  // GET /api/export/fixed-assets.xlsx. A retry with the same idempotencyKey returns the first result.
  fixedAssets: {
    list: oc.output(z.array(zFixedAsset)),
    create: oc.input(zFixedAssetCreate.extend({ idempotencyKey: zId })).output(z.object({ assetId: zId })),
    end: oc.input(zFixedAssetEnd.extend({ idempotencyKey: zId })).output(z.object({ assetId: zId })),
  },
  // Fiscal year archive packages (#922), owners only: list them, and ask for one (R3: fresh MFA) for a year whose
  // months are all locked. The package is GET /api/finance-archive/<year>/manifest and /api/finance-archive/<year>/<sha256>
  // (a part), and GET /api/finance-archive/<year>/verify checks it (zYearArchiveVerification).
  yearArchive: {
    list: oc.output(zYearArchives),
    build: oc.input(z.object({ year: zArchiveYear, idempotencyKey: zId })).output(zYearArchive),
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
