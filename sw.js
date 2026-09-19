self.addEventListener('push', function(event) {
  let body = 'You have a new secure message.';
  if (event.data) {
    body = event.data.text();
  }

  const options = {
    body: body,
    icon: '/icon.png', // Add a dummy icon reference
    badge: '/icon.png',
    vibrate: [100, 50, 100],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: '1'
    }
  };

  event.waitUntil(
    self.registration.showNotification('Reaction Game', options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('/')
  );
});
