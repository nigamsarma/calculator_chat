self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(clients.claim());
});

self.addEventListener('push', function(event) {
  event.waitUntil(new Promise((resolve) => {
    const bc = new BroadcastChannel('chat-focus');
    let isAppFocused = false;
    
    // Listen for the app's reply
    bc.onmessage = (e) => {
      if (e.data === 'focused') {
        isAppFocused = true;
      }
    };
    
    // Shout into the void to see if the app is open
    bc.postMessage('ping');
    
    // Give the app half a second to reply
    setTimeout(async () => {
      bc.close();
      
      if (isAppFocused) {
        resolve(); // App replied! Drop the notification silently.
        return;
      }
      
      // App didn't reply (it's closed or hidden). Show notification!
      let body = 'Check latest videos in Youtube!!';
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
    }, 500);
  }));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('https://www.youtube.com')
  );
});
