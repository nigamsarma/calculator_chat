self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(clients.claim());
});

let lastAwake = 0;

// Listen for the heartbeat from the app
self.addEventListener('message', (event) => {
  if (event.data === 'awake') {
    lastAwake = Date.now();
  }
});

self.addEventListener('push', function(event) {
  event.waitUntil(new Promise((resolve) => {
    // Wait 2.5 seconds to see if we hear a heartbeat from the app
    setTimeout(async () => {
      // If we heard a heartbeat in the last 3 seconds, the app is open!
      if (Date.now() - lastAwake < 1000) {
        resolve(); // Drop the notification
        return;
      }
      
      // No heartbeat heard, app is closed. Show notification!
      let body = 'Check  latest videos in Youtube!';
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
