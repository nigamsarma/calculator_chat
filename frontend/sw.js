self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(clients.claim());
});

self.addEventListener('push', function(event) {
  event.waitUntil((async () => {
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
  })());
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('https://www.youtube.com')
  );
});
