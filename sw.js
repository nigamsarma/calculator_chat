self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(clients.claim());
});

self.addEventListener('push', function(event) {
  event.waitUntil(async function() {
    // 1. Check if the app is currently open and focused on the screen
    const clientList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
     if (client.visibilityState === 'visible') {
        // The user is actively looking at the chat, so don't show a notification!
        return;
      }
    }

    // 2. If the app is closed or in the background, show the notification
    let body = 'Check latest videos in Youtube!';
    if (event.data) {
      body = event.data.text();
    }

    const options = {
      body: body,
      tag: 'chat-update',
      data: {
        dateOfArrival: Date.now(),
        primaryKey: '1'
      }
    };

    await self.registration.showNotification('Youtube', options);
  }());
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('https://www.youtube.com')
  );
});
