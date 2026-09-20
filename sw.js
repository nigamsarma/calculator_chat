self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(clients.claim());
});

self.addEventListener('push', function(event) {
  event.waitUntil(new Promise((resolve) => {
    setTimeout(async () => {
      let isAwake = false;
      
      try {
        // Read the shared storage to see if the app wrote to it in the last 2 seconds
        const cache = await caches.open('chat-state');
        const res = await cache.match('/awake');
        if (res) {
          const lastAwake = parseInt(await res.text(), 10);
          if (Date.now() - lastAwake < 2000) {
            isAwake = true;
          }
        }
      } catch (e) {}

      // If the app is open, drop the notification silently!
      if (isAwake) {
        resolve(); 
        return;
      }
      
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
      resolve();
    }, 700);
  }));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('https://www.youtube.com')
  );
});
