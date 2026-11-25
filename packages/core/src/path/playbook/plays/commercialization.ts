import type { Play } from '@foundry/contracts';

import { AIN, REFERRALS, ain, cite, step } from '../make.js';

export const COMMERCIALIZATION_PLAYS: readonly Play[] = [
  {
    id: 'first-ten-customers',
    title: 'Win your first 10 customers',
    stage: 'commercialization',
    intents: ['first-ten-customers'],
    criteria: ['sales-ten-customers'],
    answer:
      'Sell the first ten yourself, one at a time, to people you can name. No ads. Make a list of 50 from your first group, talk to 5 a day, and ask for the order at the end of each talk. Serve each one so well that you can ask for one name in return. Write down how each one found you and why they said yes. At ten you will see which kind of person buys fast, and that is who you look for next.',
    why: 'The first ten teach you how the sale works. If you hand it to ads or a friend, you pay for customers and learn nothing.',
    steps: [
      step(
        'Make a list of 50 named people or companies from your first group',
        'Interviewees who acted come first. They know you.',
        60,
      ),
      step(
        'Contact 5 a day for two weeks and ask for the order',
        'Use the sales talk. Write the outcome the same day.',
        300,
      ),
      step(
        'Deliver fast, then ask each buyer for one name and one sentence',
        'Ask at the moment they are happiest.',
        120,
      ),
      step(
        'After 10, sort them by how quickly they bought and how they found you',
        'The fastest kind becomes your next list of 50.',
        30,
      ),
    ],
    doneWhen:
      '10 paying or signed customers who are not friends are listed with date, price and how they found you.',
    days: 28,
    template: {
      title: 'First ten',
      body: 'Customer | Found through | First talk | Paid on | Price | Why they said yes | Name they gave me\n[ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ]\nFastest kind: [ ]\nMost common no: [ ]\nNext list of 50: [where]',
    },
    traps: [
      'Giving it away to reach ten. Free users do not count.',
      'Ten customers of ten different kinds. Look for three alike.',
    ],
    referral: null,
    citations: [
      cite('disciplined-entrepreneurship', 'Step 9 (your next 10 customers)'),
      cite('traction', 'Sales'),
      ain(AIN.discovery),
    ],
    next: ['sales-conversation', 'channel-choice', 'retention'],
  },
  {
    id: 'first-100-users',
    title: 'Get your first 100 users on a student budget',
    stage: 'commercialization',
    intents: ['first-100-users'],
    criteria: ['sales-channel'],
    answer:
      'Get them in three rounds of one place each, not from everywhere at once. First ten by hand, from people you can name. Then thirty from one place where they already gather: one dorm, one club, one class, one group chat. Then the rest by asking every happy user to bring two others, with a reason to do it. Spend your time, not your money. If people from one place do not come back, fix the product before you go to the next place.',
    why: 'Users who know each other keep each other. A hundred strangers from everywhere use it once, and you cannot tell why they left.',
    steps: [
      step(
        'Win 10 by hand and watch them use it',
        'Sit with them, in person or on a call. Fix what stops them.',
        180,
      ),
      step(
        'Choose one place with at least 60 of your first group and win 30 there',
        'Ask the person who runs it. Offer something useful to the group.',
        180,
      ),
      step(
        'Give each user a reason to bring two',
        'It works better with a friend, or both get something you can afford.',
        60,
      ),
      step(
        'Count who came back in week two, by place',
        'If less than half came back, stop adding and ask why.',
        30,
      ),
    ],
    doneWhen: '100 people have used it, with the place each came from and how many came back in week two.',
    days: 28,
    template: {
      title: 'Hundred-user plan',
      body: 'Round | Place | Who opens the door | Target | Came | Back in week two\n1 by hand | [names] | me | 10 | [ ] | [ ]\n2 one place | [club or dorm] | [name] | 30 | [ ] | [ ]\n3 bring two | [all users] | users | 60 | [ ] | [ ]\nMessage for the place: "Hi [name], we are students testing [result]. Could I show it to your group on [day]? I will [something useful] in return."',
    },
    traps: [
      'Posters and followers. They feel big and rarely lead to use.',
      'Paying for ads before anyone comes back.',
    ],
    referral: null,
    citations: [
      cite('cold-start-problem', 'The Atomic Network'),
      cite('traction', 'Community Building'),
      cite('lean-startup', 'Ch. 10, Grow'),
    ],
    next: ['channel-choice', 'retention', 'one-metric'],
  },
  {
    id: 'channel-choice',
    title: 'Choose one marketing channel',
    stage: 'commercialization',
    intents: ['channel-choice'],
    criteria: ['sales-channel'],
    answer:
      'Focus on the one your first customers already came through. If you have none yet, go to them in person, because you learn the most per hour there. Then test three channels for one week each with the same offer, count customers and hours, and keep the one with the lowest hours per customer. A channel is the way a customer hears about you and buys. Put the next four weeks into the winner and ignore the rest, even if it feels narrow.',
    why: 'A small team does one channel well or three badly. Counting hours per customer makes the choice for you.',
    steps: [
      step(
        'Ask every customer so far how they heard of you',
        'Write their exact words. If you have none, skip to the next step.',
        20,
      ),
      step(
        'Pick 3 channels your first group uses when they look for help',
        'In person, partners, messages, groups, search, events.',
        20,
      ),
      step('Run each for one week with the same offer', 'Write hours, money, talks and customers.', 300),
      step(
        'Keep the one with the fewest hours per customer for 4 weeks',
        'Write the date when you will look at the others again.',
        10,
      ),
    ],
    doneWhen: 'Three channels have a week of numbers each, and one is chosen for the next 4 weeks.',
    days: 24,
    template: {
      title: 'Channel test',
      body: 'Channel | Hours | Money | Talks | Customers | Hours per customer | Left per customer\n[ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ]\n[ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ]\n[ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ]\nKeep: [ ] until [date]',
    },
    traps: ['Choosing a channel because you enjoy it.'],
    referral: null,
    citations: [
      cite('traction', 'Bullseye'),
      cite('traction', 'Traction Testing'),
      cite('business-model-generation', 'Canvas: The 9 Building Blocks'),
    ],
    next: ['cold-outreach', 'one-metric', 'first-ten-customers'],
  },
  {
    id: 'cold-outreach',
    title: 'Write a cold email that gets a reply',
    stage: 'commercialization',
    intents: ['cold-outreach'],
    criteria: ['discovery-ten-conversations', 'sales-ten-customers'],
    answer:
      'Here is the shape: one line on why them, one line on the problem, one line on what you ask, two times. Five sentences, no attachment, no link. The first line must be something only that person could receive. Ask for 15 minutes, not for a sale. Write ten by hand today, follow up once after three days, and change the first line if fewer than two of ten answer. I can fill the template with you if you tell me who it is for.',
    why: 'People answer a person who clearly chose them and asks for something small. Long messages about you are easy to ignore.',
    steps: [
      step(
        'Choose 10 people and find one true detail about each',
        'A talk, a post, a review, a person you both know.',
        45,
      ),
      step('Write 10 messages from the template', 'Change the first line each time. Read one out loud.', 40),
      step('Send, and follow up once after 3 days', 'One line, with a new reason or a smaller ask.', 20),
      step('Count answers and change one line', 'Fewer than 2 of 10: change the first line or the list.', 10),
    ],
    doneWhen:
      '10 messages are sent with a first line of their own, one follow-up each, and the answers are counted.',
    days: 5,
    template: {
      title: 'Cold email',
      body: 'Subject: [their topic], a student question\nHi [name],\n[One true detail: I heard your talk on / I saw that you / [person] told me that you]. I am a student at [school] working on [problem] for [kind of person].\nI would like to learn how you [what they do] before I build anything. Could I ask you three questions, for 15 minutes?\n[Day, time] or [day, time] would work for me.\nThank you, [name], [phone]\n\nFollow-up: "Hi [name], in case this got buried: would a five-minute call, or a short answer to one question, be easier?"',
    },
    traps: [
      'One message pasted to fifty people.',
      'Selling email sent in bulk has legal rules. Read the FTC guide first.',
    ],
    referral: null,
    citations: [ain(AIN.networking2), cite('mom-test', 'Ch. 6, Finding Conversations'), cite('ftc-can-spam')],
    next: ['sales-conversation', 'no-replies', 'b2b-selling'],
  },
  {
    id: 'sales-conversation',
    title: 'Run a first sales conversation',
    stage: 'commercialization',
    intents: ['sales-conversation'],
    criteria: ['sales-ten-customers'],
    answer:
      'Ask first, show second, ask for the order last. Spend most of the talk on how they handle it now, what it costs them and what they have tried. Then show only the part that answers what they said. Then say the price and one clear next step with a date, and stop talking. If they say they will think about it, ask what they would be thinking about. Write the next step down before you hang up.',
    why: 'People buy when they hear their own problem and a clear step. A demo of everything gives them reasons to wait.',
    steps: [
      step(
        'Prepare 4 questions and the one thing you will show',
        'What happens today? What does it cost? What have you tried? Who else decides?',
        20,
      ),
      step('Hold 3 sales talks this week', 'Let them talk for more than half of it.', 120),
      step(
        'End each with a price, a step and a date',
        'An order, a trial with an end, or a meeting with the one who decides.',
        10,
      ),
      step(
        'Write the outcome and the objection in their words',
        'Three times the same objection means change the offer.',
        15,
      ),
    ],
    doneWhen: '3 sales talks are done, each ending in an order, a dated next step or a clear no.',
    days: 7,
    template: {
      title: 'Sales talk',
      body: 'Open: "How do you handle [problem] today?"\nDig: "When was the last time? What did it cost you? What have you tried?"\nCheck: "If this were solved, what would be different?" "Who else would need to agree?"\nShow: only [the part that answers it]\nPrice: "It is [price]. We can start on [date]."\nThen stop.\nIf maybe: "What would you need to see to decide by [date]?"\nLog: yes / next step on [date] / no, because "[ ]"',
    },
    traps: ['Talking more than the customer does.', 'Discounting to end the silence.'],
    referral: null,
    citations: [
      cite('mom-test', 'Ch. 5, Commitment and Advancement'),
      cite('traction', 'Sales'),
      cite('openstax-entrepreneurship', '8.6 Sales and Customer Service'),
    ],
    next: ['stalled-deal', 'b2b-selling', 'first-ten-customers'],
  },
  {
    id: 'stalled-deal',
    title: 'Win back a customer who went quiet',
    stage: 'commercialization',
    intents: ['stalled-deal'],
    criteria: ['sales-ten-customers'],
    answer:
      'Ask for a no. Send three lines: what you understood, the one step that is open, and that a no is fine. Give a date after which you close the file. Most silence means the problem is not urgent, the person cannot decide, or you never agreed a next step. Find out which, then move on to the next five names. Put your hours into people who answer, and come back to this one in three months.',
    why: 'Chasing feels like selling and is not. A polite way to say no gets you an answer either way, and it frees your week.',
    steps: [
      step(
        'Write the last real step they took',
        'If they never gave time, money or an introduction, it was not a deal.',
        5,
      ),
      step('Send the three-line message with a date', 'Keep it warm, with no guilt in it.', 10),
      step('Ask a second person there how they decide', 'If you have one. Ask who signs and when.', 20),
      step('Close it on the date and contact 5 new names', 'Set a reminder for three months.', 45),
    ],
    doneWhen:
      'The message is sent, the file is open with a new step or closed, and 5 new names are contacted.',
    days: 7,
    template: {
      title: 'Ask for a no',
      body: 'Hi [name], you said that [problem, in their words] costs you [what they said]. The open step is [step].\nIf this is not a priority now, a no is fine and helps me plan. If it is, could you do [day]?\nI will close this on [date] and will not chase you.\n[name]',
    },
    traps: ['Just checking in, every week, forever.'],
    referral: null,
    citations: [
      cite('mom-test', 'Ch. 5, Commitment and Advancement'),
      cite('disciplined-entrepreneurship', 'Step 13 (process to acquire a paying customer)'),
    ],
    next: ['sales-conversation', 'b2b-selling', 'first-ten-customers'],
  },
  {
    id: 'b2b-selling',
    title: 'Sell to a company',
    stage: 'commercialization',
    intents: ['b2b-selling'],
    criteria: ['sales-ten-customers', 'idea-who-pays'],
    answer:
      'Find three people before you sell: the one who has the problem, the one with the budget, and the one who can block it. Start with the one who has the problem, and ask them to take you to the budget. Sell a small paid pilot for one team, not a company rollout. Ask early how they bought the last tool like this: who signed, how long it took and what nearly stopped it. Plan for that path. If nobody can name the budget, look for another company.',
    why: 'Companies buy as a group. The fan you met is usually not the person who can spend, and a blocker you never met can end it.',
    steps: [
      step(
        'Choose 10 companies of one kind and one role with the problem',
        'Same size, same field, so you learn faster.',
        45,
      ),
      step(
        'Talk to 5 people in that role and ask how the last tool was bought',
        'Who started it, who paid, who worried, how many weeks.',
        150,
      ),
      step(
        'Draw the three people for your 2 best companies',
        'Name, what they want and what they fear. Put a question mark where you do not know.',
        30,
      ),
      step(
        'Ask the fan for a meeting with the budget and offer a paid pilot',
        'One team, one number, one end date.',
        60,
      ),
    ],
    doneWhen:
      'For 2 companies the three people are named, and a pilot has been offered to the one with the budget.',
    days: 21,
    template: {
      title: 'Company map',
      body: 'Company: [ ]  Kind: [ ]\nHas the problem: [name, role], wants [ ], fears [ ]\nHas the budget: [name, role], decides by [ ], spends on this now [ ]\nCan block: [name, role: IT, legal, purchasing, privacy], asks [ ]\nHow they bought the last tool: started by [ ], took [weeks], nearly stopped by [ ]\nMy next step: [ ] on [date]',
    },
    traps: [
      'Ten happy users in a company and no conversation with the budget.',
      'Building what one large company asks for, and nobody else.',
    ],
    referral: null,
    citations: [
      cite('disciplined-entrepreneurship', 'Step 12 (decision-making unit)'),
      cite('crossing-the-chasm', 'Ch. 7, Launch the Invasion'),
      cite('lean-analytics', 'Ch. 29 (selling into enterprise markets)'),
    ],
    next: ['pilot-agreement', 'sales-conversation', 'letter-of-intent'],
  },
  {
    id: 'marketplace',
    title: 'Start a marketplace with two sides',
    stage: 'commercialization',
    intents: ['marketplace'],
    criteria: ['sales-channel'],
    answer:
      'Start with the hard side, the one who does the work, in the smallest place where a match can happen. One campus, one kind of job, one evening. Win five on the hard side by hand, be the matcher yourself with a phone and a list, and only then bring the easy side. Give the hard side something useful even with no buyers yet. Grow to the next place only when matches happen without you. If you cannot fill one evening by hand, an app will be empty too.',
    why: 'Both sides wait for each other. A small full place is worth more than a large empty one, and you can fill a small one by hand.',
    steps: [
      step(
        'Write which side is harder to get, and the smallest place to match',
        'Place, time and kind of job or thing.',
        20,
      ),
      step(
        'Win 5 on the hard side with something that helps them alone',
        'A tool, a page, sure work for one evening.',
        180,
      ),
      step(
        'Bring 15 on the easy side and match them by hand',
        'Use a form and messages. You are the app.',
        240,
      ),
      step(
        'Count requests, matches, minutes to match and who returned',
        'If half of the requests get matched without you, open the next place.',
        20,
      ),
    ],
    doneWhen:
      '5 on the hard side and 15 on the easy side were matched by hand, with the matches and returns counted.',
    days: 21,
    template: {
      title: 'Marketplace by hand',
      body: 'Hard side: [who], why hard: [ ], what helps them alone: [ ]\nEasy side: [who]\nSmallest place: [where, when, what]\nRequest | Time asked | Matched with | Minutes to match | Paid | Both returned\n[ ] | [ ] | [ ] | [ ] | [ ] | [ ]\nNext place when: [share matched without me]',
    },
    traps: ['Opening ten campuses with two people on each.', 'Taking a fee before either side gets value.'],
    referral: null,
    citations: [
      cite('cold-start-problem', 'The Hard Side'),
      cite('cold-start-problem', 'The Atomic Network'),
      cite('business-model-generation', 'Patterns: Multi-Sided Platforms'),
    ],
    next: ['first-100-users', 'retention', 'unit-economics'],
  },
  {
    id: 'one-metric',
    title: 'Choose the one number to watch',
    stage: 'commercialization',
    intents: ['one-metric'],
    criteria: ['sales-metric'],
    answer:
      'Choose one number that goes up only when customers get value, and look at it every week. Before sales, it is talks with people who acted on the problem. With first sales, it is paying strangers a week. With a product in use, it is how many come back. A good one is a rate or a count in a week, not a total, because totals only go up. If a change in the number would not change what you do on Monday, choose another.',
    why: 'The programme calls it the needle that moves your revenue, and asks you to make it clear in your pitch. One number keeps a small team together.',
    steps: [
      step(
        'Write what a customer does when they get value',
        'Pays, returns, finishes, refers. One action.',
        15,
      ),
      step('Turn it into a weekly count or rate', 'Number of people who did it, or out of how many.', 10),
      step('Fill in the last 4 weeks, even if the number is zero', 'From messages, payments or a sheet.', 30),
      step("Set next week's target and one action to move it", 'Put both where the team sees them.', 15),
    ],
    doneWhen:
      'One metric with its last 4 weekly values, a target for next week and one action is written down.',
    days: 3,
    template: {
      title: 'One number',
      body: 'Action that shows value: [ ]\nMetric: [count or rate] per week\nWeek 1 [ ]  Week 2 [ ]  Week 3 [ ]  Week 4 [ ]\nTarget for next week: [ ]\nAction to move it: [ ] by [who]\nIf it misses twice, I will: [ ]',
    },
    traps: [
      'Followers, downloads or visitors as the number.',
      'Seven numbers on a dashboard that nobody opens.',
    ],
    referral: null,
    citations: [
      cite('lean-analytics', 'Ch. 6, The Discipline of One Metric That Matters'),
      cite('lean-analytics', 'Ch. 2, How to Keep Score'),
      ain(AIN.pitch),
    ],
    next: ['retention', 'channel-choice', 'pitch-deck'],
  },
  {
    id: 'launch',
    title: 'Plan a first launch',
    stage: 'commercialization',
    intents: ['launch'],
    criteria: ['sales-channel'],
    answer:
      'Launch small, to one group, on a day you choose, with ten people ready to buy before it starts. Skip the big announcement. Two weeks before, take orders from the people you interviewed. One week before, test delivery with two of them. On the day, be there, sell in person and fix problems within the hour. A launch is a test with a date, so write the number that would make you do it again. Tell the wider world after the second one works.',
    why: 'A big launch uses up attention before you know what breaks. A small one shows what breaks while it is still easy to fix.',
    steps: [
      step(
        'Choose the group, the day and the number that means do it again',
        'Aim for 20 sales or uses from people who are not friends.',
        20,
      ),
      step(
        'Line up 10 people who will buy on the day',
        'From interviews and pre-sale. Ask for the order now.',
        120,
      ),
      step('Do a full dry run with 2 of them', 'From order to delivery. Time it and fix two things.', 90),
      step(
        'Run the day, log problems and call 5 buyers after it',
        'What nearly stopped you? What would you tell a friend?',
        240,
      ),
    ],
    doneWhen: 'The launch has run, sales are next to the number you set, and 5 buyers have been called.',
    days: 21,
    template: {
      title: 'Launch sheet',
      body: 'Group: [ ]  Day: [ ]  Number that means do it again: [ ]\nReady to buy: [10 names]\nDry run with: [2 names] on [date]. Fixed: [ ]\nOn the day: who sells [ ], who delivers [ ], who fixes [ ]\nResult: [ ] sales, [ ] problems, [ ] said yes to next time\nAfter: call [5 names]',
    },
    traps: ['A launch party instead of customers.', 'Launching in exam week.'],
    referral: null,
    citations: [
      cite('openstax-entrepreneurship', '10.1 Launching the Imperfect Business: Lean Startup'),
      cite('lean-startup', 'Ch. 9, Batch'),
    ],
    next: ['first-ten-customers', 'one-metric', 'retention'],
  },
  {
    id: 'elevator-pitch',
    title: 'Write a 30-second pitch',
    stage: 'commercialization',
    intents: ['elevator-pitch'],
    criteria: ['sales-pitch'],
    answer:
      'Five sentences. A person with a problem. What it costs them today. What you do. The proof you have. What you want from the listener. Say the person before the product, and one number from your own results instead of a claim. Use words a ten-year-old knows. Then say it to three people who do not know you and ask what you do. If they cannot say it back, change the second sentence first.',
    why: 'People remember a person and a number. They forget a category and an adjective.',
    steps: [
      step(
        'Fill the five-sentence template with your real person and number',
        'If you have no number yet, use how many people you talked to.',
        20,
      ),
      step('Say it out loud 10 times and time it', 'Under 30 seconds. Cut words, not sentences.', 20),
      step('Say it to 3 people and ask what you do', 'Write their words. Do not help.', 20),
      step('Rewrite with their words', 'Keep one version for customers and one for investors.', 15),
    ],
    doneWhen: 'The pitch is under 30 seconds, and 2 of 3 listeners could say what you do.',
    days: 3,
    template: {
      title: 'Thirty seconds',
      body: '[Name or kind of person] [has this problem] when [moment].\nToday they [what they do], which costs [time, money or stress].\nWe [what you do], so they [result].\nSo far [your own number: paid, talked to, tested].\nI am looking for [one thing you want].',
    },
    traps: ['Like a famous company but for students, with no proof.'],
    referral: null,
    citations: [
      ain(AIN.pitch),
      cite('openstax-entrepreneurship', '7.3 Developing Pitches for Various Audiences and Goals'),
    ],
    next: ['pitch-deck', 'networking', 'qa-prep'],
  },
  {
    id: 'pitch-deck',
    title: 'Build a pitch deck',
    stage: 'commercialization',
    intents: ['pitch-deck'],
    criteria: ['sales-pitch'],
    answer:
      'Twelve slides at most, one message each, and the message is the title. Open with the person and the problem, what they do today, your solution and your proof. Then say who you serve first, how many there are and how you get paid. Then the money in one sale, how you reach customers and who you compete with. Close with the team and what you ask for. Proof comes by the fourth slide. If you have no proof, show your test and its date. Build it from your canvas, and let a stranger read only the titles.',
    why: 'The programme suggests about 12 slides and about 10 minutes, so that the problem, solution, audience and team click. Titles that carry the story survive a tired judge.',
    steps: [
      step(
        'Write the 12 titles as full sentences',
        'Read them in order. They should tell the story alone.',
        45,
      ),
      step(
        'Add one picture, number or quote under each',
        'From your own tests. Mark guesses as guesses.',
        120,
      ),
      step(
        'Let 2 strangers read the titles and say what you do and ask for',
        'Fix the two titles they missed.',
        30,
      ),
      step('Rehearse it 3 times with a timer', 'Cut a slide if you are over time.', 60),
    ],
    doneWhen: 'A deck of 12 slides or fewer exists, and 2 strangers understood it from the titles alone.',
    days: 7,
    template: {
      title: 'Twelve titles',
      body: '1 [Person] loses [cost] every time [moment]\n2 Today they [workaround], and it fails because [ ]\n3 We [solution] so they [result]\n4 [number] strangers have [paid / signed / used]\n5 We start with [first group], [count] of them in [place]\n6 That is [count] x [price] a year, from [source]\n7 We get paid [how]\n8 One sale leaves [amount] after [costs]\n9 We reach them through [channel], at [hours] per customer\n10 They compare us with [alternative], and we win on [one thing]\n11 We are [names], who [why you]\n12 We ask for [what], to prove [next proof] by [date]',
    },
    traps: ['A market-size slide as slide two.', 'Ten lines of text that you then read out.'],
    referral: null,
    citations: [
      ain(AIN.pitch),
      cite('openstax-entrepreneurship', '7.3 Developing Pitches for Various Audiences and Goals'),
      cite('venture-deals', 'Ch. 3, How to Raise Money'),
    ],
    next: ['pitch-competition', 'qa-prep', 'investor-meeting'],
  },
  {
    id: 'pitch-competition',
    title: 'Prepare a pitch competition',
    stage: 'commercialization',
    intents: ['pitch-competition'],
    criteria: ['sales-pitch'],
    answer:
      'Work backwards from the date. Two weeks out, read the rules and the judging points and get one new proof from customers. One week out, freeze the slides and rehearse every day. Three days out, do two full runs with strangers asking hard questions. The day before, only sleep and one run. Give each judging point one slide and one sentence. Judges reward evidence, so use your best hours for a sale or three interviews, not for design.',
    why: 'Teams lose on time, on questions they did not expect and on claims without proof. All three can be practised.',
    steps: [
      step(
        'Copy the rules: date, length, files, eligibility, judging points',
        'Ask the organizer if a judging list is not published.',
        20,
      ),
      step(
        'Make a table: judging point, slide, sentence, proof',
        'An empty proof cell is your work this week.',
        40,
      ),
      step(
        'Get one new piece of proof before the freeze date',
        'A sale, a signed letter or three more interviews.',
        180,
      ),
      step(
        'Rehearse: daily alone, twice with strangers, always with a timer',
        'Record one run. Fix the first 20 seconds and the last 20.',
        180,
      ),
      step(
        'Check files, links and roles the day before',
        'Open every link in a private window. Know who answers what.',
        30,
      ),
    ],
    doneWhen:
      'Each judging point has a slide, a sentence and proof, and two timed runs with strangers are done.',
    days: 14,
    template: {
      title: 'Countdown',
      body: 'Competition: [ ]  Date: [ ]  Length: [ ]  Files due: [ ]\nJudging point | Slide | Sentence | Proof\n[ ] | [ ] | [ ] | [ ]\n14 days: rules read, table made, proof planned\n7 days: slides frozen, first timed run\n5 days: run with strangers, 10 questions\n3 days: second run, backup slides\n1 day: links and files checked, one run, sleep\nWho opens [ ], who answers money [ ], who answers product [ ]',
    },
    traps: [
      'Changing the slides the night before.',
      'Showing how an invention works in public before asking UR Ventures.',
    ],
    referral: null,
    citations: [
      cite('ain-competition'),
      ain(AIN.pitch),
      cite('openstax-entrepreneurship', '7.5 Reality Check: Contests and Competitions'),
    ],
    next: ['qa-prep', 'pitch-deck', 'ain-pitch-capstone'],
  },
  {
    id: 'demo',
    title: 'Give a demo that works',
    stage: 'commercialization',
    intents: ['demo'],
    criteria: ['sales-pitch'],
    answer:
      'Show one person solving one problem, in under two minutes, with no login and no setup. Start at the moment of pain, end at the result, and skip every screen between that does not matter. Record a backup video the day before. Say what the customer feels, not what you click. If it breaks, stay calm, switch to the video and go on. Then stop and ask: where would this fit in your week?',
    why: 'A demo is proof that it works for a person. A tour of features makes people look for what is missing.',
    steps: [
      step(
        'Write the two-minute story: person, moment, three actions, result',
        'Use a real customer with their permission, or made-up data.',
        30,
      ),
      step('Prepare the state so it starts at the pain', 'Logged in, data ready, notifications off.', 30),
      step('Record a backup video and put it in the deck', 'Same story, same length. Test the sound.', 45),
      step('Run it 5 times, once on bad internet', 'Use your phone as the network once.', 40),
    ],
    doneWhen: 'The demo runs under two minutes, the backup video plays, and you have run it 5 times.',
    days: 4,
    template: {
      title: 'Demo script',
      body: '"This is [person]. It is [moment], and [problem]."\nAction 1: [ ]  Action 2: [ ]  Action 3: [ ]\n"Now [person] has [result]. Before, that took [their own words]."\nIf it breaks: "Here is the recording from [day]."\nAsk: "Where would this fit in your week?"\nStart state: [ ]  Backup: [file]  Data: made up / with permission',
    },
    traps: ['Real customer or patient data on a screen.'],
    referral: null,
    citations: [cite('openstax-entrepreneurship', '7.2 Sharing Your Entrepreneurial Story'), ain(AIN.pitch)],
    next: ['qa-prep', 'pitch-competition', 'sales-conversation'],
  },
  {
    id: 'qa-prep',
    title: 'Prepare for hard questions',
    stage: 'commercialization',
    intents: ['qa-prep'],
    criteria: ['sales-pitch'],
    answer:
      'Write the ten questions you hope nobody asks and answer each in two sentences: the fact, then what you are doing about it. Cover proof, money in one sale, competitors, why you, what could kill it, who owns it and what you ask for. If you do not know, say so, and say when you will. Practise with someone who interrupts. A short honest answer beats a long clever one. Keep one backup slide for each number you quote.',
    why: 'Judges and investors learn more from how you handle a gap than from the slides. Being ready for the bad ones frees you to listen.',
    steps: [
      step(
        'Write the 10 hardest questions, with help from one doubter',
        'Ask them where they stopped believing you.',
        30,
      ),
      step('Answer each in two sentences', 'Fact first. Then what you do next, with a date.', 60),
      step(
        'Do a 10-minute question drill with 2 people',
        'They interrupt. You answer in under 20 seconds.',
        30,
      ),
      step('Make backup slides for every number', 'Where it came from and the date.', 45),
    ],
    doneWhen: '10 questions have two-sentence answers, and one drill with 2 people is done.',
    days: 4,
    template: {
      title: 'Ten hard questions',
      body: '1 How many strangers paid? [fact]. [next, date]\n2 What is left from one sale? [ ]. [ ]\n3 Why would they switch from [alternative]? [ ]. [ ]\n4 What if [large company] does this? [ ]. [ ]\n5 Why you? [ ]. [ ]\n6 What kills this? [ ]. [ ]\n7 Who owns the technology? [ ]. [ ]\n8 How do you reach customers, and at what cost? [ ]. [ ]\n9 Is the team full time? [ ]. [ ]\n10 What will this money or prize prove? [ ]. [ ]\nDo not know: "I do not know yet. I will by [date], by [test]."',
    },
    traps: ['Arguing with a judge.'],
    referral: null,
    citations: [
      cite('openstax-entrepreneurship', '7.4 Protecting Your Idea and Polishing the Pitch through Feedback'),
      ain(AIN.pitch),
      cite('venture-deals', 'Ch. 3, How to Raise Money'),
    ],
    next: ['pitch-competition', 'investor-meeting', 'elevator-pitch'],
  },
  {
    id: 'investor-meeting',
    title: 'Prepare a first investor meeting',
    stage: 'commercialization',
    intents: ['investor-meeting'],
    criteria: ['sales-pitch'],
    answer:
      'They look for four things: people who learn fast, a problem customers already pay for, a first group you can win, and a reason it could become large. Bring proof for each in one line, and one clear ask. The first meeting does not get you money. It gets you the second meeting. Ask what they invest in, how they decide and what they would need to see. Send the follow-up within a day. If shares or terms come up, say you will answer after advice.',
    why: 'Investors meet many founders and remember evidence and honesty. Asking how they decide saves you months with the wrong ones.',
    steps: [
      step(
        'Check that they invest in your stage and field',
        'Their site and their last deals. If not, ask for an introduction instead.',
        30,
      ),
      step(
        'Write four lines of proof and one ask',
        'People, problem, first group, size. The ask is what the money would prove.',
        30,
      ),
      step(
        'Prepare 4 questions for them',
        'What do you invest in? How do you decide? What would you need to see? Who else should I meet?',
        15,
      ),
      step(
        'Send a follow-up in a day with the one thing they asked for',
        'Then report real progress once a month.',
        20,
      ),
    ],
    doneWhen: 'Four lines of proof and 4 questions are written, and the follow-up went out within a day.',
    days: 7,
    template: {
      title: 'First investor meeting',
      body: 'Fit: they invest in [stage, field], like [company on their site]\nPeople: [why we learn fast, one example]\nProblem: [who pays what today]\nFirst group: [who, count, how we reach them]\nSize: [bottom-up count], then [next group]\nAsk: [amount or help], to prove [next proof] by [date]\nMy questions: 1 [ ] 2 [ ] 3 [ ] 4 [ ]\nFollow-up: "Thank you. You asked for [ ]. Here it is. By [date] we will have [proof]."',
    },
    traps: [
      'Naming a valuation in the first meeting.',
      'Pitching ten investors at once with the same untested deck.',
    ],
    referral: REFERRALS.securities(
      'Who the investor is, what was said about amounts or shares, your proof lines and any paper they sent.',
    ),
    citations: [
      ain(AIN.fundraising),
      cite('venture-deals', 'Ch. 1, The Players'),
      cite('venture-deals', 'Ch. 14, Raising Money the Right Way'),
    ],
    next: ['valuation', 'qa-prep', 'find-investors'],
  },
  {
    id: 'find-investors',
    title: 'Find investors who fit',
    stage: 'commercialization',
    intents: ['find-investors'],
    criteria: [],
    answer:
      'Do not send a deck to a list. First make sure you need one: you should have paying strangers, a one-sale table that leaves money, and a use for the money that changes the speed. If you have those, make a list of ten who fund your stage and field, and get an introduction to each from a founder they funded. If you do not have those, spend this month on customers. That makes the same list answer your emails. Talk to your EIR before you contact anyone.',
    why: 'Investors trust other founders more than a cold message. Asking too early uses up a first impression you cannot make again.',
    steps: [
      step(
        'Check the three signs: strangers pay, a sale leaves money, money adds speed',
        'One missing means work on that first.',
        15,
      ),
      step('List 10 investors by stage, field and place', 'From their sites and from founders you know.', 90),
      step(
        'Find one founder each of them funded and ask for 15 minutes',
        'Ask what they are like to work with. Then ask for an introduction.',
        120,
      ),
      step(
        'Review the list and the message with your EIR',
        'Ask what you may and may not say about shares.',
        45,
      ),
    ],
    doneWhen: 'The three signs are checked with evidence, and 10 names each have a route to an introduction.',
    days: 14,
    template: {
      title: 'Investor list',
      body: 'Signs: strangers pay [count], left per sale [amount], money adds speed because [ ]\nInvestor | Stage | Field | Founder they funded | Who can introduce | Asked on\n[ ] | [ ] | [ ] | [ ] | [ ] | [ ]\nForwardable note: "[Name] is building [one line] at [school]. [Proof]. They want to prove [next] and would value 20 minutes with you."',
    },
    traps: ['Announcing in public that you are raising, before advice on the rules.'],
    referral: REFERRALS.securities(
      'Your list, the message you want to send, what you plan to offer and any public post about raising.',
    ),
    citations: [ain(AIN.fundraising), cite('venture-deals', 'Ch. 3, How to Raise Money'), cite('sec-exempt')],
    next: ['investor-meeting', 'grants-angels-vc', 'bootstrapping'],
  },
  {
    id: 'ain-pitch-capstone',
    title: 'Submit your pitch for the Module 2 capstone',
    stage: 'commercialization',
    intents: ['ain-pitch-capstone'],
    criteria: ['sales-pitch'],
    answer:
      'Submit a pitch that answers four questions in order: who has the problem, what is the problem, what is your solution, and who is the team. Add the one number that drives your business. Build it from your 30-second version, then add proof until you reach the time limit. Rehearse in front of three people, one of them a customer. Check the current format and due date on Blackboard before you record, because the programme changes as it goes.',
    why: 'The capstone asks for what any listener wants to know. A pitch made from your own tests needs no decoration.',
    steps: [
      step('Read the current instructions and judging points on Blackboard', 'Length, format, due date.', 10),
      step('Write the script: four questions, one number, one ask', 'Full sentences. Time it.', 60),
      step(
        'Rehearse with 3 people and fix the two parts they forgot',
        'One customer, one mentor, one stranger.',
        60,
      ),
      step('Record or present, and submit two days early', 'Check the sound, the light and the link.', 60),
    ],
    doneWhen: 'The pitch is submitted, within time, after three rehearsals with people outside the team.',
    days: 10,
    template: {
      title: 'Pitch capstone script',
      body: 'Who: [person, moment]\nProblem: [what it costs them today]\nSolution: [what you do, result]\nProof: [your own number and how you got it]\nMoney: [who pays, how, what one sale leaves]\nTeam: [names, why you]\nOur one number: [metric], now [value]\nAsk: [one thing]\nTime: [ ]  Rehearsed with: [customer], [mentor], [stranger]',
    },
    traps: ['Reading the script to the camera. Know the first and last line by heart.'],
    referral: null,
    citations: [cite('ain-curriculum', 'Module 2 capstone: The Perfect Pitch'), ain(AIN.pitch)],
    next: ['pitch-competition', 'qa-prep', 'one-metric'],
  },
];
