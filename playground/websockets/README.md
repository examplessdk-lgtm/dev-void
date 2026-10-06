# WebSocket Playground

React Pages playground for Void's typed WebSocket support.

## Demos

- `Chat room` uses `defineRoom()` with a route-scoped room at `/ws/chat/:room`
- `Notifications` uses `defineWebSocket()` with a single socket stream at `/ws/notifications`

## Run

```sh
vp run --filter ./playground/websockets dev
```

Then open the local app and try:

- switching chat rooms
- reconnecting with a different display name
- starting and stopping the notification stream
- acknowledging individual notifications
