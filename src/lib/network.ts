import dns from "node:dns";

// Some networks (observed live against api.telegram.org, same class of
// issue documented in .env.example for Ollama/localhost) advertise IPv6
// but route it unreliably, causing intermittent ETIMEDOUT on outbound
// HTTPS calls that would succeed instantly over IPv4. Preferring IPv4
// results process-wide avoids this without touching any specific client.
dns.setDefaultResultOrder("ipv4first");
