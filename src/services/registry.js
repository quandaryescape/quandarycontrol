/**
 * Process-wide access to the live services (io, timers, variables, automations).
 * Set once by createServer(); legacy route modules read from here instead of
 * requiring server.js (which caused a circular import).
 */
let services = null;

function setServices(s) {
  services = s;
}

function getServices() {
  return services;
}

module.exports = { setServices, getServices };
