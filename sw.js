self.addEventListener("push", (event) => {
  event.waitUntil(
    self.registration.showNotification("System update pending", {
      body: "A system update is waiting.",
      tag: "calculator-system-update",
      renotify: false,
      silent: true
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const client = list.find(c => "focus" in c);
    return client ? client.focus() : clients.openWindow("/");
  }));
});
