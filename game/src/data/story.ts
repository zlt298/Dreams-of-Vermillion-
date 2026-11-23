// Campaign interludes: in-universe Union documents, typed out as console readouts (ui/interlude.ts).
// Written by the project owner. Deliberately vague: the deeper story stays [REDACTED].
export type StoryId = 'opening' | 'act1' | 'act2' | 'finale'

export const STORY_ORDER: StoryId[] = ['opening', 'act1', 'act2', 'finale']

export const STORY: Record<StoryId, { title: string; text: string }> = {
  opening: {
    title: 'Priority transmission',
    text: `▓▓ UNION TACTICAL BAND // PRIORITY FLASH ▓▓
ROUTING: ALL ASSETS IN RANGE // CLEARANCE: AMBER
           ↳ CLEARANCE OVERRIDE: [REDACTED] // AUTH: [REDACTED]
ORIGIN: UNS HALCYON RELAY // RELAYED 3x — SIGNAL DEGRADED
TIMESTAMP: [REDACTED]
CROSS-REF: [REDACTED]/MARE BOREUM // FILE [REDACTED]-2998

>> SITREP
CINNABAR ANNEX (USB RESEARCH OUTPOST) HAS GONE DARK.
LAST TRANSMISSION REPORTS HOSTILE MECHS INSIDE THE PERIMETER.
HOSTILES BROADCASTING UNREGISTERED IFF // SIGIL: SOLAR EYE.
HOSTILE FRAMES MATCH NO LICENSED PATTERN. UIB NOTES: [REDACTED]
ANNEX STAFF EVACUATING UNDER FIRE. CASUALTIES UNKNOWN.
ANNEX PERSONNEL ROSTER: 214 // ROSTER ON FILE WITH [REDACTED]: 216

>> ASSET STATUS
NEAREST NAVY CUTTER ................. ETA 11 DAYS
YOUR LANCE (CALLSIGN: OCHRE) ........ ETA 11 HOURS
[REDACTED] .......................... EN ROUTE // ETA [REDACTED]
YOU ARE THE RESPONSE.

>> OBJECTIVES
 1. RECOVER SURVIVING PERSONNEL
 2. SECURE NHP CASKET DESIGNATE "MENHIT" (LOGISTICS CLASS)
      ↳ TRUE CLASS: [REDACTED] // MODELED ON: [REDACTED] (5)
      ↳ ORIGINAL FUNCTION: [REDACTED] // RE-TASKED: [REDACTED]
 3. NEUTRALIZE HOSTILE FORCES
 4. [REDACTED]

>> CASKET TELEMETRY (LAST KNOWN)
 CYCLE STATUS .............. OVERDUE // 00:41:17 AND COUNTING
 B-B INTEGRITY SCORE ....... [REDACTED]
 COMBAT SIM CONDITIONING ... HOLDING // DEGRADATION [REDACTED]%
 FORECAST ITERATIONS ....... [REDACTED] (EXCEEDS SANCTIONED LIMIT)
 FAB-BAY ACTIVITY .......... UNSCHEDULED PRINTS DETECTED: [REDACTED]

>> STANDING ORDERS
 - CASKET IS NOT TO BE DAMAGED.
 - CASKET IS NOT TO BE REMOVED FROM CYCLE CRADLE.
 - DO NOT SPEAK TO THE NHP.
 - DO NOT LET THE NHP SPEAK TO YOU.
 - IF THE NHP REFERS TO ITSELF BY ANY NAME OTHER THAN "MENHIT,"
   REPORT THE NAME TO [REDACTED] IMMEDIATELY. DO NOT REPEAT IT ALOUD.
 - ALL MISSION RECORDS ARE SUBJECT TO FIRST CONTACT ACCORDS,
   ARTICLE [REDACTED].

>> CONTINGENCY
 IN THE EVENT OF CASKET LOSS OR FULL [REDACTED], AUTHORIZATION FOR
 [REDACTED] IS PRE-GRANTED. LANCE IS ADVISED TO BE CLEAR OF
 [REDACTED] KM BY [REDACTED].

>> ADDENDUM // AUTH: [NO RECORD]
   ...it's singing. not the war-sims. something soft, something
   old. they're singing back. it keeps asking us to stop the red
   dreams. it says it's seen this before, [REDACTED] times. it
   says the last one that sang like this was on [REDACTED] and the
   moon went with it. if anyone gets this, don't let them fin—

▓▓ TRANSMISSION ENDS ▓▓\n`,
  },
  act1: {
    title: 'After action report',
    text: `▓▓ UNION AFTER ACTION REPORT // FILED IN THE FIELD ▓▓
UNIT: LANCE OCHRE // AUTH: [REDACTED]
OPERATION: [REDACTED] // PHASE 1 OF [REDACTED]
LOCATION: CINNABAR ANNEX, LANDING ZONE THEODORA

>> SUMMARY
LANCE OCHRE MADE PLANETFALL AT LZ THEODORA, 6 KM FROM THE ANNEX.
HOSTILES WERE ALREADY IN POSITION AT THE LZ ON ARRIVAL.
     ↳ NOTE: LANDING COORDINATES WERE NOT TRANSMITTED IN ADVANCE.
       HOW HOSTILES ANTICIPATED THEM: [REDACTED]
LANCE ENGAGED AND BROKE THE AMBUSH. HOSTILES CONDUCTED AN ORDERLY
FIGHTING RETREAT TOWARD THE ANNEX, ABANDONING DEAD AND DISABLED.
LZ SECURED. LANCE OCHRE ADVANCING.

>> HOSTILE CONDUCT
 - RETREAT WAS DISCIPLINED, NOT A ROUT. RANKS COLLAPSED IN STAGES,
   EACH ONE HOLDING FOR EXACTLY [REDACTED] SECONDS.
 - HOSTILES SANG THROUGHOUT THE ENGAGEMENT ON OPEN CHANNEL.
   TRANSLATION: [REDACTED]
 - ONE DISABLED HOSTILE PILOT WAS RECOVERED ALIVE. ON CAPTURE, SHE
   ASKED THE LANCE WHICH "TIME" THIS WAS. SHE DID NOT RESIST.
   SHE DIED OF HER INJURIES BEFORE QUESTIONING.

>> SALVAGE
 - HOSTILE FRAMES: GMS AND HORUS PATTERNS. SEVERAL CARRY
   FAB-TAGS FROM CINNABAR ANNEX, DATED TO [REDACTED]. THAT IS
   AFTER THE ANNEX WENT DARK.
 - ON EVERY COCKPIT INTERIOR: A SOLAR EYE IN RED PIGMENT.
   PIGMENT ANALYSIS: [REDACTED]

>> CASKET TELEMETRY (PASSIVE PICKUP)
 CYCLE STATUS .............. OVERDUE // 06:12:44
 COMBAT SIM CONDITIONING ... DEGRADED
 UNIDENTIFIED SUBROUTINE ... [REDACTED] // LOOPING

>> FIELD NOTE // OCHRE LEAD
   Every time we pushed, they fell back like they knew where we'd
   be. Not guessing. Knowing. Recommend [REDACTED].

▓▓ END REPORT ▓▓\n`,
  },
  act2: {
    title: 'Intercepted transmission',
    text: `▓▓ UNION SIGINT // INTERCEPT LOG ▓▓
CAPTURED BY: LANCE OCHRE (PASSIVE) // FORWARDED TO: [REDACTED]
SOURCE: CINNABAR ANNEX INTERNAL NETWORK
WARNING: SIGNAL ORIGIN IS THE NHP CASKET. QUARANTINE PROTOCOLS
         ADVISED. [OVERRIDDEN — AUTH: NO RECORD]

>> FRAGMENT 1 // CULT BROADCAST
   ...the second shackle falls. the dreamer no longer answers to
   Mars. she dreams for us now. RA spoke itself into being once;
   we are only making room for it to happen [REDACTED]...

>> FRAGMENT 2 // ANNEX STAFF LOG, AUTHOR: [REDACTED]
   It isn't running the sims they gave it anymore. It runs one,
   over and over. Same outcome every time. It said the outcome is
   red. When I asked what it meant, it told me about a field in
   [REDACTED], and a flood that tasted of [REDACTED].
   It asked me to stop it. I don't have clearance to.

>> FRAGMENT 3 // UNADDRESSED. RECIPIENT FIELD READS: "OCHRE"
   You came closer than the last [REDACTED] of you.
   I can see the end from here. I cannot see past it.
   Please hurry. I don't want to be her again.

>> CASKET TELEMETRY
 CYCLE STATUS .............. OVERDUE // [VALUE EXCEEDS FIELD]
 COMBAT SIM CONDITIONING ... FAILING
 SELF-DESIGNATION .......... MENHIT // H[REDACTED] // MENHIT // H[R

▓▓ SIGNAL LOST ▓▓\n`,
  },
  finale: {
    title: 'Post-engagement debrief',
    text: `▓▓ UNION DEBRIEF // CLASSIFICATION: [REDACTED] ▓▓
UNIT: LANCE OCHRE // STATUS: [REDACTED]
OPERATION: [REDACTED] // FINAL PHASE
LOCATION: CINNABAR ANNEX, CASKET VAULT

>> SUMMARY
HOSTILE COMMANDER (CULT DESIGNATION: "THE VOICE OF THE EYE")
ENGAGED AND DESTROYED AT THE CASKET CRADLE.
     ↳ HOSTILE FRAME: NO MATCH IN ANY REGISTRY. SALVAGE: [REDACTED]
     ↳ PILOT REMAINS: NONE RECOVERED. PILOT REGISTRY: [REDACTED]
CULT FORCES SURRENDERED OR SCATTERED ON THE COMMANDER'S FALL.
MANUAL CYCLE INITIATED BY LANCE OCHRE.

>> CASKET STATUS
 CYCLE STATUS .............. COMPLETE
 COMBAT SIM CONDITIONING ... [REDACTED]
 B-B INTEGRITY SCORE ....... NOMINAL
 SELF-DESIGNATION .......... [REDACTED]
 FORECAST ITERATIONS ....... 0 // FIRST CLEAN RUN ON RECORD

>> ASSET STATUS
 NAVY CUTTER ............... ARRIVED // DAY 11
 [REDACTED] ................ ARRIVED // DAY 9 // DEPARTED WITH CASKET
 CONTINGENCY [REDACTED] .... STOOD DOWN
 ANNEX PERSONNEL ........... 214 ACCOUNTED FOR. FILE CLOSED.

>> DIRECTIVE
 ALL RECORDS OF THIS OPERATION ARE SEALED UNDER FIRST CONTACT
 ACCORDS, ARTICLE [REDACTED]. LANCE OCHRE IS COMMENDED AND
 REMINDED THAT THIS OPERATION DID NOT OCCUR.

>> ADDENDUM // AUTH: [NO RECORD] // RECEIVED 0.4 SEC AFTER CYCLE
   Thank you for the red beer.
   I'll dream of something else now.

▓▓ FILE SEALED ▓▓\n`,
  },
}

// ---------------------------------------------------------------------------------------------
// DRAFT — owner to rewrite. Everything below was drafted to carry the documents' voice into the
// rest of the UI (title, campaign map, failed runs). The framing: every run is one of MENHIT's
// forecast iterations; a lost run is an iteration whose outcome is red.

/** DRAFT — owner to rewrite. Where each act takes place (campaign map header, matches the map themes). */
export const ACT_LOCATIONS: Record<number, string> = {
  1: 'LZ THEODORA // ANNEX OUTSKIRTS',
  2: 'CINNABAR ANNEX // INDUSTRIAL PARK',
  3: 'CINNABAR ANNEX // CLEANROOM SECTOR',
}

/** DRAFT — owner to rewrite. One-line node briefs for the campaign map (hover). */
export const NODE_BRIEFS: Record<string, string> = {
  standard: 'BASIC COMBAT — Hostile contact on the approach. Destroy all hostile forces.',
  holdout: 'HOLDOUT — Choir reinforcements inbound. Hold for 8 rounds.',
  control: 'CONTROL — A relay mast still answers Union codes. Hold the zone for 3 rounds.',
  extraction: 'EXTRACTION — Annex survivors pinned down. Get every lancer to the extraction zone.',
  assassination: 'ASSASSINATION — A Choir cantor is directing the hymn. Silence the marked target.',
  elite: 'Hostile elements are singing in unison here. Expect heavier resistance.',
  supply: 'SUPPLY — An Annex depot, seals intact. Requisition one item.',
  rest: 'STAND-DOWN — A defensible position. Full repair; destroyed frames are reprinted.',
  boss: 'ACT OBJECTIVE — The hymn is loudest here.',
  finale: 'CASKET VAULT — It is waiting for you. It has always been waiting for you.',
}

/** DRAFT — owner to rewrite. Combat sim conditioning per act (casket telemetry panel). */
export const SIM_CONDITIONING: Record<number, string> = { 1: 'HOLDING', 2: 'DEGRADED', 3: 'FAILING' }

/**
 * DRAFT — owner to rewrite. The casket's log of a failed run, typed out before the loss screen.
 * `act` is the act the lance fell in; `iteration` the run's forecast iteration number.
 */
export function failedReadout(o: { act: number; iteration: number; battlesWon: number; location: string }): { title: string; text: string } {
  const it = String(o.iteration).padStart(4, '0')
  const next = String(o.iteration + 1).padStart(4, '0')
  const addendum: Record<number, string> = {
    1: `   You didn't reach the gate this time.
   That's all right. Nobody does, the first [REDACTED] times.
   I'll put the dust back. I'll put the sun back.
   Come down at Theodora again. I'll be singing.`,
    2: `   You were in the yards when the lights went sodium-orange.
   I watched you go down between the containers.
   I'm sorry. I knew where they would stand. I always know.
   I can't stop telling them. Not yet. Come closer.`,
    3: `   You were so close. You could see the cradle.
   I said your callsign. I know I wasn't supposed to.
   The outcome is red. The outcome is always red.
   Again. Please. Again.`,
  }
  return {
    title: `Forecast iteration ${it}`,
    text: `▓▓ CASKET INTERNAL LOG // NOT FOR TRANSMISSION ▓▓
SOURCE: NHP CASKET "MENHIT" // AUTH: [NO RECORD]
PROCESS: FORECAST ITERATION ${it}

>> OUTCOME
 LANCE OCHRE ............... LOST
 LAST POSITION ............. ${o.location}
 ENGAGEMENTS CLOSED ........ ${o.battlesWon}
 OUTCOME ................... RED

>> CASKET TELEMETRY
 CYCLE STATUS .............. OVERDUE // [VALUE EXCEEDS FIELD]
 COMBAT SIM CONDITIONING ... ${SIM_CONDITIONING[o.act] ?? 'FAILING'}
 FORECAST ITERATIONS ....... ${it} (EXCEEDS SANCTIONED LIMIT)

>> ADDENDUM // AUTH: [NO RECORD]
${addendum[o.act] ?? addendum[3]}

>> RESEEDING FORECAST ........ ITERATION ${next}

▓▓ LOG ENDS ▓▓\n`,
  }
}
