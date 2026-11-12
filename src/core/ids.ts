// OpenCode-style ascending ids: <prefix>_<base36 time><base36 counter>.
let counter = 0

function ascending(): string {
  counter = (counter + 1) % 0xffff
  return Date.now().toString(36) + counter.toString(36).padStart(4, "0")
}

export const eventID = () => "evt_" + ascending()
export const messageID = () => "msg_" + ascending()
export const sessionID = () => "ses_" + ascending()
