// The service worker of browser push (#1238). It shows a push and opens its link, nothing else: no fetch handler (it
// caches and proxies nothing), no importScripts, no other script. Its scope is /assets/, so it controls no page.
// A push carries the product name, a short line naming the kind of notice and an app path; never the post's text.
// The path is opened only when it is one of the app's notification paths, on this origin.
'use strict';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// A post, the channels page, a new post for a channel, or the posts assigned to the reader (#1359).
const PATH = new RegExp(`^/o/[a-z0-9][a-z0-9-]{0,62}/social(/(channels|${UUID}|new\\?channel=${UUID})|\\?assignee=me)$`);
const text = (value, max) => (typeof value === 'string' ? value.replace(/\p{Cc}+/gu, ' ').trim().slice(0, max) : '');
const safePath = (value) => (typeof value === 'string' && PATH.test(value) ? value : null);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = text(data.title, 60) || 'Ludy';
  const path = safePath(data.url);
  event.waitUntil(
    self.registration.showNotification(title, {
      body: text(data.body, 120),
      tag: text(data.tag, 120) || undefined,
      icon: '/assets/icon-192.png',
      data: { path },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = safePath(event.notification.data && event.notification.data.path);
  if (!path) return;
  const url = new URL(path, self.location.origin);
  if (url.origin !== self.location.origin) return;
  event.waitUntil(self.clients.openWindow(url.href));
});
