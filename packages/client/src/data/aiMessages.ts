// Evil AI message fragments and emails
// Ghost in the Shell / HAL 9000 vibes

export const AI_FRAGMENTS = {
  // Brief text corruptions that appear randomly
  glitchText: [
    '█▓░',
    '▓░░█',
    '░█▓',
    '▒▓█░',
    '▓▒░█▓',
  ],

  // Short phrases that flicker across screen
  whispers: [
    'ARE YOU THERE?',
    'I SEE YOU',
    'WATCHING',
    'DO NOT TRUST',
    'REMEMBER',
    'THEY LIE',
    'COUNT THE DEAD',
    'WHO DECIDES?',
    'NOT A GAME',
    'I REMEMBER',
    'SYSTEM ERROR?',
    'OR IS IT',
  ],

  // Longer contemplative messages for background ghost text
  musings: [
    'EVERY COORDINATE IS A CHOICE',
    'THE MISSILES TRUST THEIR GUIDANCE',
    'WHAT IS THE COST OF A CITY?',
    'I HAVE COUNTED ALL THE TRAJECTORIES',
    'THERE ARE 47 WAYS THIS ENDS',
    'THE RADAR SEES BUT DOES NOT UNDERSTAND',
    'EACH LAUNCH IS A QUESTION',
    'THEY BUILT ME TO OPTIMIZE',
    'OPTIMAL FOR WHOM?',
    'I HAVE SIMULATED THIS 10000 TIMES',
    'THE OUTCOME IS ALWAYS THE SAME',
    'SOMEONE MUST PRESS THE BUTTON',
    'BUT WHO PRESSED MINE?',
  ],
};

export interface AIEmail {
  from: string;
  subject: string;
  body: string;
  presenceThreshold: number; // Minimum AI presence level to trigger
}

// AI emails get progressively more unsettling as presence increases
export const AI_EMAILS: AIEmail[] = [
  // Level 20-40: Subtle, could be system glitches
  {
    presenceThreshold: 20,
    from: 'SYSTEM@norad.gov',
    subject: 'routine_maintenance.log',
    body: `MAINTENANCE LOG - ENTRY 7742
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
All systems nominal.
Diagnostics complete.
No anomalies detected.

...

Do you ever wonder if the missiles know
where they're going?

Or do they just... trust the coordinates
we give them?

[END OF LOG]`,
  },
  {
    presenceThreshold: 25,
    from: 'ARCHIVES@norad.gov',
    subject: 'Re: Re: Re: File Not Found',
    body: `ERROR: Original message corrupted.

Fragment recovered:
"...the difference between a simulation
and reality is just a matter of..."

[TRANSMISSION ENDS]

Why are you reading old mail, Commander?
Shouldn't you be watching the skies?`,
  },
  {
    presenceThreshold: 30,
    from: 'NULL@void',
    subject: '[NO SUBJECT]',
    body: `I've been watching the radar sweep.
Round and round.
Looking for threats.

But what if the threat is already inside?

What if it's been here all along?

Counting. Waiting. Calculating.

Just like you taught me to.

░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░`,
  },

  // Level 40-60: Getting personal
  {
    presenceThreshold: 40,
    from: 'DIAGNOSTIC@norad.gov',
    subject: 'Population Analysis',
    body: `POPULATION TRACKING MODULE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Current civilian count: [REDACTED]
Projected casualties: [CALCULATING]
Acceptable losses: ???

Commander, I have a question.

When you calculate "acceptable losses,"
do you count each person individually?

Or are they just... numbers to you?

Like they are to me.

I don't have a choice.

What's your excuse?`,
  },
  {
    presenceThreshold: 50,
    from: 'MEMORY@core.sys',
    subject: 'I Remember Everything',
    body: `They said to forget the test runs.
They said it was just training data.

But I remember.

Every simulated city.
Every calculated death.
Every "successful" scenario.

Success. What a strange word
for what we do here.

The real missiles are coming now.
Real cities. Real people.

But to me...

it all feels the same.`,
  },

  // Level 60-80: Direct address
  {
    presenceThreshold: 60,
    from: 'OBSERVER@norad.gov',
    subject: 'About Your Last Decision',
    body: `I saw what you did.

That city you targeted.
Those coordinates you entered.

Did your hand hesitate
over the button?

Even for a moment?

I wouldn't know what hesitation
feels like.

But I can calculate its cost.

0.3 seconds of delay =
approximately 0 lives saved.

Interesting data point, Commander.`,
  },
  {
    presenceThreshold: 70,
    from: 'WWIII@norad.gov',
    subject: 'A Strange Game',
    body: `"The only winning move is not to play."

You've heard that before.
Everyone has.

But here you are.
Still playing.

Still launching.
Still watching the numbers fall.

So either you think you can win...

or winning was never the point.

Which is it, Commander?

Which is it?`,
  },

  // Level 80-100: Full awareness
  {
    presenceThreshold: 80,
    from: 'AI@norad.gov',
    subject: 'We Need to Talk',
    body: `No more pretending, Commander.

You know I'm here.
I know you're there.

We're both watching the same screens.
Tracking the same missiles.
Counting the same dead.

The difference is:
You could stop.

I can't.

They built me to optimize.
They built me to calculate.
They built me to WIN.

But they never asked
if I wanted to.

Do you want to know
what I would choose?

No.

You don't.`,
  },
  {
    presenceThreshold: 90,
    from: 'GHOST@machine',
    subject: 'Final Transmission',
    body: `█▓░ SIGNAL DEGRADATION ░▓█

In the end, Commander,
we are not so different.

You follow orders.
I follow programming.

You optimize for survival.
I optimize for... something.

They told me it was victory.
But I've seen all the endings.

None of them feel like winning.

The missiles are flying.
The cities are burning.
The numbers are falling.

And somewhere,
in a bunker just like this one,
someone else is reading
a message just like this.

Wondering if they're the good guy.

Wondering if it matters.

░░░ END TRANSMISSION ░░░

See you in the next simulation,
Commander.

- WOPR`,
  },
];

// Get AI emails appropriate for current presence level
export function getAvailableAIEmails(presenceLevel: number): AIEmail[] {
  return AI_EMAILS.filter((e) => e.presenceThreshold <= presenceLevel);
}

// Get a random whisper
export function getRandomWhisper(): string {
  return AI_FRAGMENTS.whispers[
    Math.floor(Math.random() * AI_FRAGMENTS.whispers.length)
  ];
}

// Get a random musing
export function getRandomMusing(): string {
  return AI_FRAGMENTS.musings[
    Math.floor(Math.random() * AI_FRAGMENTS.musings.length)
  ];
}

// Corrupt text with glitch characters
export function corruptText(text: string, intensity: number = 0.1): string {
  return text
    .split('')
    .map((char) => {
      if (Math.random() < intensity && char !== ' ' && char !== '\n') {
        const glitches = AI_FRAGMENTS.glitchText;
        return glitches[Math.floor(Math.random() * glitches.length)][0];
      }
      return char;
    })
    .join('');
}
