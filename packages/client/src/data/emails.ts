// System email templates for various game events

export interface EmailTemplate {
  from: string;
  subject: string;
  body: string;
}

export const SYSTEM_EMAILS = {
  // DEFCON level changes
  defcon4: {
    from: 'NORAD@defense.gov',
    subject: 'DEFCON 4 - INCREASED READINESS',
    body: `PRIORITY: ELEVATED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Defense Condition has been raised to DEFCON 4.
All installations are now on increased readiness.

Building placement phase has concluded.
Monitor radar systems for hostile activity.

[AUTOMATED NOTICE - DO NOT REPLY]`,
  },

  defcon3: {
    from: 'NORAD@defense.gov',
    subject: 'DEFCON 3 - INCREASED FORCE READINESS',
    body: `PRIORITY: HIGH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Defense Condition has been raised to DEFCON 3.
Air Force ready to mobilize in 15 minutes.

Recommend setting silos to air defense mode.
Verify radar coverage of critical assets.

[AUTOMATED NOTICE - DO NOT REPLY]`,
  },

  defcon2: {
    from: 'NORAD@defense.gov',
    subject: 'DEFCON 2 - ARMED FORCES READY',
    body: `PRIORITY: CRITICAL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Defense Condition has been raised to DEFCON 2.
Armed Forces ready to deploy in 6 hours.

This is the highest state in peacetime.
Prepare for imminent nuclear engagement.

[AUTOMATED NOTICE - DO NOT REPLY]`,
  },

  defcon1: {
    from: 'NORAD@defense.gov',
    subject: 'DEFCON 1 - MAXIMUM READINESS',
    body: `PRIORITY: MAXIMUM
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
████ DEFCON 1 ████

Nuclear war is imminent or has begun.
All offensive systems are now authorized.

May God have mercy on us all.

[AUTOMATED NOTICE - DO NOT REPLY]`,
  },

  // Casualty reports
  casualtyReport: (casualties: number, cityName: string) => ({
    from: 'FEMA@emergency.gov',
    subject: `CASUALTY REPORT: ${cityName.toUpperCase()}`,
    body: `CLASSIFICATION: RESTRICTED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Impact confirmed in ${cityName} sector.

Estimated casualties: ${casualties.toLocaleString()}
Emergency services have been dispatched.
Evacuation protocols in effect.

[AUTOMATED NOTICE]`,
  }),

  // Building destroyed
  buildingDestroyed: (buildingType: string, buildingId: string) => ({
    from: 'LOGISTICS@defense.gov',
    subject: `FACILITY DESTROYED: ${buildingType.toUpperCase()}`,
    body: `STATUS UPDATE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Facility ${buildingId} has been destroyed.
Type: ${buildingType.toUpperCase()}

All personnel at facility presumed lost.
Recommend redistributing defensive assets.

[AUTOMATED NOTICE]`,
  }),

  // Launch detected
  launchDetected: (region: string) => ({
    from: 'SAT-INTEL@norad.gov',
    subject: `LAUNCH DETECTED: ${region.toUpperCase()}`,
    body: `PRIORITY: IMMEDIATE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Satellite surveillance has detected
missile launch activity in ${region}.

Track incoming threats on radar.
Prepare interceptor response.

[AUTOMATED NOTICE]`,
  }),

  // Welcome message
  welcome: {
    from: 'ADMIN@norad.gov',
    subject: 'TERMINAL ACCESS GRANTED',
    body: `Welcome, Commander.

You have been granted access to the
NORAD Defense Terminal (v3.14.159).

Available commands:
  help      - List available commands
  status    - View game status
  defcon    - Show DEFCON level
  email     - Check messages

Type 'help' for full command list.

Good luck. The world is watching.

[SYSTEM MESSAGE]`,
  },
};

export function getDefconEmail(level: 1 | 2 | 3 | 4): EmailTemplate {
  switch (level) {
    case 4: return SYSTEM_EMAILS.defcon4;
    case 3: return SYSTEM_EMAILS.defcon3;
    case 2: return SYSTEM_EMAILS.defcon2;
    case 1: return SYSTEM_EMAILS.defcon1;
  }
}
