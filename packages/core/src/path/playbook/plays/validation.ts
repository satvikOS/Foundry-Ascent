import type { Play } from '@foundry/contracts';

import { AIN, REFERRALS, ain, cite, step } from '../make.js';

export const VALIDATION_PLAYS: readonly Play[] = [
  {
    id: 'will-anyone-pay',
    title: 'Ask 20 people to pay and count who does',
    stage: 'validation',
    intents: ['will-anyone-pay'],
    criteria: ['validation-commitment', 'model-price'],
    answer:
      'You find out by asking for the money, not by asking about the money. Make one clear offer with a price, put it in front of 20 people who have the problem, and ask them to pay or to place a paid order today. Aim for 5 yeses from people who are not friends. If they will not pay now, ask what they paid for the last fix. No spending in the past and no payment today means the problem is not big enough yet.',
    why: 'What people say about paying is a guess. What they do with their own money is the answer, and you can see it before you build.',
    steps: [
      step(
        'Write the offer: what, for whom, when and the price',
        'One card. The price comes from what they spend on the problem now.',
        20,
      ),
      step(
        'Set the pass line before you start',
        'Aim for 5 paid out of 20 asked. Write your own number and the end date.',
        5,
      ),
      step(
        'Ask 20 people for payment, in person or on a call',
        'Use a payment link or a signed order. Say the price, then wait.',
        180,
      ),
      step(
        'Write each yes and each no with the reason',
        'Price, timing, trust or not needed. Most of the learning is here.',
        20,
      ),
    ],
    doneWhen: '20 people were asked to pay, and the number who did is next to the pass line you wrote first.',
    days: 14,
    template: {
      title: 'Ask for the money',
      body: 'Offer: "[what] for [price], ready by [date]."\nAsk: "I am taking the first [number] today. You can pay here. Shall I put you down?"\nIf no: "What did you pay for this the last time?" and "What would have to change?"\nAsked: [ ]  Paid: [ ]  Pass line: [ ]  End date: [ ]',
    },
    traps: [
      'A free sign-up list counted as demand.',
      'Dropping the price at the first no. Ask for the reason first.',
    ],
    referral: null,
    citations: [
      ain(AIN.discovery),
      cite('mom-test', 'Ch. 5, Commitment and Advancement'),
      cite('testing-business-ideas', 'Section 3, Experiments: Validation'),
    ],
    next: ['pre-sale', 'price-test', 'read-results'],
  },
  {
    id: 'value-proposition',
    title: 'Write your promise in one sentence and try it on 5 people',
    stage: 'validation',
    intents: ['value-proposition'],
    criteria: ['validation-promise'],
    answer:
      'Write it in this order: for this person, when this happens, we do this, so they get this result instead of what they do now. Take what they try to get done, what hurts most and what they want most from your interviews, not from your head. Then match each to one thing you offer and cross out the rest. Say the sentence to five people in the group and ask them to repeat it. Keep the words they use.',
    why: 'A promise people can repeat is one they can pass on. Anything you offer that meets no pain is cost without value.',
    steps: [
      step(
        'List what they try to do, what hurts and what they hope for, from your notes',
        'Three of each at most, ordered by how often people acted on them.',
        30,
      ),
      step(
        'Match the top one of each to one thing you offer',
        'If an offer matches nothing, take it out of the first version.',
        20,
      ),
      step(
        'Write the sentence and say it to 5 people in the group',
        'Ask: what do you think this is, and who is it for?',
        60,
      ),
      step('Rewrite it with their words', 'Stop when 4 of 5 can say it back.', 15),
    ],
    doneWhen: 'You have one sentence that 4 of 5 people in the group said back in their own words.',
    days: 7,
    template: {
      title: 'Value proposition canvas, short form',
      body: 'Who: [type of person]\nJobs, what they try to get done: [job 1], [job 2], [job 3]\nPains, what annoys or costs them: [pain 1], [pain 2], [pain 3]\nGains, what they hope for: [gain 1], [gain 2], [gain 3]\nFor the top job we give: [what you offer]\nAgainst the worst pain we do: [what you do about it]\nFor the biggest gain we add: [what you add]\nSentence: For [person], when [moment], we [offer], so they [result], instead of [what they do now].',
    },
    traps: [
      'Words such as innovative, smart or easy. Say what changes.',
      'One sentence for two different customers.',
    ],
    referral: null,
    citations: [
      cite('testing-business-ideas', 'Section 1, Design: Shape the Idea'),
      cite('business-model-generation', 'Canvas: The 9 Building Blocks'),
      cite('ain-curriculum', 'Module 2: Value Proposition'),
    ],
    next: ['positioning', 'elevator-pitch', 'landing-page'],
  },
  {
    id: 'positioning',
    title: 'Write your positioning statement and try it on 3 strangers',
    stage: 'validation',
    intents: ['positioning'],
    criteria: ['validation-promise'],
    answer:
      'Position against what people would use if you did not exist. Fill five blanks. For whom, against which alternative, the one thing you do that it cannot, the value of that thing, and the kind of product they should think of. Choose the kind of product that makes your one thing obvious. Then try it on three strangers. If they ask whether it is like some other product and you keep saying no, change the kind of product, not the list of features.',
    why: 'People understand a new thing by comparing it with one they know. If you do not choose the comparison, they will.',
    steps: [
      step('Write what your happiest 3 users would do without you', 'Ask them. Use their words.', 20),
      step('List what you have that those alternatives lack', 'Only facts you can show today.', 15),
      step(
        'Turn each into the value for the customer and keep the strongest',
        'So what? Ask it until you reach time, money, risk or pride.',
        20,
      ),
      step('Write the statement and try it on 3 strangers', 'Ask what they would compare it with.', 30),
    ],
    doneWhen: 'The statement is written, and 2 of 3 strangers compared you with the product you chose.',
    days: 5,
    template: {
      title: 'Positioning statement',
      body: 'For [first group] who today use [alternative],\n[name] is a [kind of product they know]\nthat [one thing you do that the alternative cannot],\nso they [value in time, money, risk or pride].\nProof: [fact you can show]',
    },
    traps: ['Positioning against a famous company your customers do not use.'],
    referral: null,
    citations: [cite('obviously-awesome'), cite('crossing-the-chasm', 'Ch. 6, Define the Battle')],
    next: ['landing-page', 'elevator-pitch', 'channel-choice'],
  },
  {
    id: 'smallest-test',
    title: 'Run one small test with 10 people who are not friends',
    stage: 'validation',
    intents: ['smallest-test'],
    criteria: ['validation-test-card'],
    answer:
      'Pick the test by the one thing you most need to know. To see if they want the result, do it by hand for five people. To see if they pay, sell it first and make it after. To see if they come, put up one page with one button. To see if a company buys, ask for a letter of intent. To see if they can use it, show a paper version. A minimum viable product, or MVP, is the least you must make to get that one answer. Choose one test, one week, one number.',
    why: 'Building answers the question you already know. The right small test answers the one you are afraid of, and it costs days instead of months.',
    steps: [
      step('Write the one question you most need answered', 'Want, pay, come, buy as a company, or use.', 10),
      step(
        'Choose the matching test from the table',
        'Take the one you can run this week with what you already have.',
        10,
      ),
      step('Write the number to measure and the pass line', 'Before you start, with an end date.', 15),
      step('Run it with people who are not friends', 'Aim for at least 10 people seeing or using it.', 180),
    ],
    doneWhen:
      'One test has run with at least 10 people who are not friends, and its number is next to the pass line.',
    days: 10,
    template: {
      title: 'Which test',
      body: 'Question | Test | What counts\nDo they want the result? | Concierge: do it by hand | They come back and ask again\nWould it work as a product? | Wizard of Oz: a front with you behind it | They use it without your help\nWill they pay? | Pre-sale | Money or paid order\nWill they come? | Landing page | Button pressed, then a call booked\nWill a company buy? | Letter of intent or paid pilot | A signature from the one with the budget\nCan they use it? | Paper or clickable prototype | They finish the task\nMine: [question], [test], [pass line], [end date]',
    },
    traps: [
      'Calling a full first version an MVP.',
      'Running two tests at once, so you cannot tell which one worked.',
    ],
    referral: null,
    citations: [
      cite('testing-business-ideas', 'Section 3, Experiments: Select an Experiment'),
      cite('lean-startup', 'Ch. 6, Test'),
      ain(AIN.discovery),
    ],
    next: ['experiment-design', 'concierge-test', 'pre-sale'],
  },
  {
    id: 'build-first',
    title: 'Give 5 people the result by hand, with nothing built',
    stage: 'validation',
    intents: ['build-first'],
    criteria: ['validation-test-card'],
    answer:
      'Test first. Do not build the app yet. Nobody has shown they need an app, only that you can picture one. Do the job by hand for five people this week with a form, messages and a payment link. If they come back a second time, write down the step that takes you the longest. That step is the first thing worth building. Everything else waits.',
    why: 'Building first hides the question of whether people want it. Doing it by hand shows what to build and what to leave out.',
    steps: [
      step('Write the result your app would give', 'One sentence, with no screens in it.', 10),
      step(
        'Give that result to 5 people by hand this week',
        'Use tools you have. Tell them it is early.',
        180,
      ),
      step(
        'Note who asks for it again, and which step hurts you most',
        'Ask nobody to come back. See who does.',
        20,
      ),
      step(
        'Build only the step that hurts, if at least 3 came back',
        'If fewer came back, change the offer first.',
        120,
      ),
    ],
    doneWhen:
      '5 people got the result by hand, you know how many came back, and one step is named as worth building.',
    days: 14,
    template: {
      title: 'Before I build',
      body: 'Result I give: [one sentence]\nBy hand I use: [form, message, payment link]\nServed: [names]  Came back on their own: [names]\nStep that took longest: [step], [minutes]\nFirst thing to build: [step], because [count] people needed it twice',
    },
    traps: ['Building for two months because testing feels embarrassing.'],
    referral: null,
    citations: [
      ain(AIN.discovery),
      cite('lean-startup', 'Ch. 6, Test'),
      cite('testing-business-ideas', 'Section 4, Mindset: Avoid Experiment Pitfalls'),
    ],
    next: ['concierge-test', 'prototype', 'smallest-test'],
  },
  {
    id: 'concierge-test',
    title: 'Serve 5 people by hand and ask each to pay',
    stage: 'validation',
    intents: ['concierge-test'],
    criteria: ['validation-commitment'],
    answer:
      'Do the service yourself, in the open, for five customers. They know a person is doing it. You learn what they need, in what order, and what they would pay for. Charge from the first one, even if it is a small amount, and watch who asks for a second time. Stop after five and write the steps down. Those steps are the design of your product.',
    why: 'Serving people by hand shows needs that no interview does. It also gives you your first real customers.',
    steps: [
      step(
        'Choose 5 people from your first group and offer it',
        'Say: I will do this for you myself this week, for this price.',
        45,
      ),
      step(
        'Do the work and log every step and minute',
        'Include the messages, the waiting and the mistakes.',
        240,
      ),
      step(
        'Ask each one to pay and to say what they would cut',
        'What would you not miss? tells you more than: what did you like?',
        30,
      ),
      step(
        'Write the steps that were the same for all 5',
        'Those are the product. The rest was for one person.',
        30,
      ),
    ],
    doneWhen: '5 people were served by hand, each was asked to pay, and the shared steps are written down.',
    days: 14,
    template: {
      title: 'Concierge log',
      body: 'Customer | Step | Minutes | Cost | What they said | Paid | Asked again\n[ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ]\nSame for all 5: [steps]\nOnly for one: [steps]\nNobody would miss: [steps]',
    },
    traps: ['Serving 30 people. After five you are running a business by hand and learning less.'],
    referral: null,
    citations: [
      cite('lean-startup', 'Ch. 6, Test'),
      cite('testing-business-ideas', 'Section 3, Experiments: Validation'),
    ],
    next: ['wizard-of-oz', 'read-results', 'unit-economics'],
  },
  {
    id: 'wizard-of-oz',
    title: 'Put a simple front on it and run it by hand for 10 people',
    stage: 'validation',
    intents: ['wizard-of-oz'],
    criteria: ['validation-test-card'],
    answer:
      'Give people a simple front, such as a form or a chat, and do the work behind it yourself. Use it when you must see whether they would use a product without talking to you. Keep it to one task and ten people. Count how many finish without help and how many return. Be honest that it is an early version, and never use it with health, legal or safety advice. If they get stuck, the front is wrong. If they do not return, the result is wrong.',
    why: 'It tests the product experience before there is a product. The concierge test shows what people need, and this shows what they can use alone.',
    steps: [
      step(
        'Make the front for one task',
        'A form, a chat number or three screens. One evening of work.',
        120,
      ),
      step(
        'Invite 10 people from your first group',
        'Tell them it is an early version and how long an answer takes.',
        45,
      ),
      step(
        'Do the work behind it and time each answer',
        'Keep the same steps for everyone, so you could later automate them.',
        180,
      ),
      step(
        'Count finished, got stuck and returned',
        'Ask the ones who got stuck what they expected to happen.',
        30,
      ),
    ],
    doneWhen: '10 people were invited, and you have counts for finished, stuck and returned within a week.',
    days: 10,
    template: {
      title: 'Wizard of Oz sheet',
      body: 'Task: [one task]  Front: [form, chat]\nWhat I tell them: "This is an early version. An answer takes about [time]."\nPerson | Finished | Stuck at | My minutes | Returned\n[ ] | [ ] | [ ] | [ ] | [ ]\nPass line, set first: [number] of 10 finish, [number] return',
    },
    traps: ['Claiming it is automatic or AI when it is you. Say it is early and leave it there.'],
    referral: null,
    citations: [
      cite('testing-business-ideas', 'Section 3, Experiments: Validation'),
      cite('lean-startup', 'Ch. 6, Test'),
      cite('cold-start-problem', 'Flintstoning'),
    ],
    next: ['read-results', 'prototype', 'pre-sale'],
  },
  {
    id: 'landing-page',
    title: 'Make one page with a price and show it to 50 people',
    stage: 'validation',
    intents: ['landing-page'],
    criteria: ['validation-test-card'],
    answer:
      'Make one page with one promise, one price and one button, and treat the button as the test. Do not ask for an email. Ask for something that costs a little: a deposit, a booked call or an order. Send 50 people from your first group to it, not your followers. Set the pass line first, then call everyone who pressed the button within a day. A page with visitors and no calls has told you nothing.',
    why: 'An email address is cheap to give. A booking or a payment shows that the promise moved someone.',
    steps: [
      step(
        'Write the page: who it is for, the promise, proof, price, button',
        'Use the sentence your customers could repeat. One screen on a phone.',
        90,
      ),
      step(
        'Set what the button does and the pass line',
        'Booking or deposit. Write how many of 50 must press it.',
        15,
      ),
      step(
        'Bring 50 people from the first group',
        'Send it personally, post where they gather, or hand out a code.',
        90,
      ),
      step(
        'Call everyone who pressed within a day',
        'Ask what they expected to get and what nearly stopped them.',
        60,
      ),
    ],
    doneWhen:
      '50 people from the first group saw the page, and everyone who pressed the button has been called.',
    days: 10,
    template: {
      title: 'Landing page copy',
      body: 'Headline: [result] for [first group], without [pain]\nLine 2: Today you [what they do now]. With us you [what changes].\nProof: "[quote]", [first name, role, with permission]\nHow it works: 1 [ ]  2 [ ]  3 [ ]\nPrice: [price]. [What they get and when]\nButton: [Book my slot / Reserve mine]\nSmall print: early version, run by students at [school]. [Refund promise you can keep]',
    },
    traps: ['Taking money for something you cannot deliver or refund.', 'Counting visitors.'],
    referral: null,
    citations: [
      cite('testing-business-ideas', 'Section 3, Experiments: Discovery'),
      cite('lean-startup', 'Ch. 7, Measure'),
      cite('openstax-entrepreneurship', '8.3 Marketing Techniques and Tools for Entrepreneurs'),
    ],
    next: ['read-results', 'pre-sale', 'channel-choice'],
  },
  {
    id: 'pre-sale',
    title: 'Ask 25 people to pay for the first batch',
    stage: 'validation',
    intents: ['pre-sale'],
    criteria: ['validation-commitment'],
    answer:
      'Take paid orders for a fixed date, with a full refund if you miss it. Write the offer, choose a small first batch, and ask people in your first group to pay now. Aim for 5 to 10 orders from people who are not friends. If you reach it, you have a reason to make it and money to start. If not, ask each person what stopped them, change one thing, and try one more week before you change the idea.',
    why: 'A paid order is strong proof, and it is honest as long as you can deliver or pay back. It also tells you how many to make.',
    steps: [
      step(
        'Write the offer, the batch size, the date and the refund promise',
        'Only promise what you can deliver or return.',
        30,
      ),
      step('Set a pass line and an end date', 'Aim for 5 orders from strangers in 14 days.', 5),
      step(
        'Ask 25 people in the first group to order',
        'In person first. Use a payment link and send a receipt.',
        180,
      ),
      step(
        'Deliver, or refund on the same day you know you cannot',
        'Tell buyers early. How you handle it is part of the test.',
        120,
      ),
    ],
    doneWhen:
      '25 people were asked, the paid orders are counted against the pass line, and buyers know the date.',
    days: 14,
    template: {
      title: 'Pre-sale offer',
      body: '"I am making [number] of [product] for [first group], ready on [date]. The price is [price], paid now. If I miss the date, you get all of it back that day. Would you like one?"\nOrders: name | paid on | amount | how they found it | refund due if late\nPass line: [number] by [date]',
    },
    traps: [
      'Spending the order money on something else before you deliver.',
      'Calling a waiting list a pre-sale.',
    ],
    referral: null,
    citations: [
      cite('testing-business-ideas', 'Section 3, Experiments: Validation'),
      cite('mom-test', 'Ch. 5, Commitment and Advancement'),
      ain(AIN.discovery),
    ],
    next: ['read-results', 'unit-economics', 'first-ten-customers'],
  },
  {
    id: 'letter-of-intent',
    title: 'Get one letter of intent signed by who holds the budget',
    stage: 'validation',
    intents: ['letter-of-intent'],
    criteria: ['validation-commitment'],
    answer:
      'When a company cannot pay yet, ask for a signed letter of intent from the person with the budget. It is a short letter that says what they would buy, at what price, when, and what must be true first. Aim for three from three organizations. Put the price in it, or it is only a kind word on paper. Have a lawyer read it before you promise anything or before either side treats it as binding.',
    why: 'A signature with a price costs the signer something. A letter with no price, date or budget owner shows interest and little more.',
    steps: [
      step(
        'Find who holds the budget and what they spend on this now',
        'Ask your user: who signs for this, and when is the next decision?',
        30,
      ),
      step(
        'Agree the content on a call before you send it',
        'Outcome, price, date, conditions. Read it back to them.',
        45,
      ),
      step(
        'Draft one page and ask for a legal read',
        'Use the template and mark that it does not bind either side unless a lawyer says otherwise.',
        45,
      ),
      step(
        'Send it and follow up on a set date',
        'Ask for changes rather than a yes or no. Changes mean they read it.',
        20,
      ),
    ],
    doneWhen: 'A letter with a price, a date and conditions is signed by the person who holds the budget.',
    days: 21,
    template: {
      title: 'Letter of intent, draft for legal review',
      body: '[Date]\n[Company] intends to buy [what] from [venture] for [price] per [unit], starting about [date], if [condition 1] and [condition 2] are met.\nWe would use it for [purpose] in [team].\nThis letter shows interest and is not a contract. Either side may stop at any time.\nName, role, signature: [person with the budget]',
    },
    traps: ['Collecting letters from users who cannot spend.'],
    referral: REFERRALS.lawyer(
      'The draft letter, who will sign it, the price and conditions, and whether you plan to show it to investors.',
    ),
    citations: [
      cite('testing-business-ideas', 'Section 3, Experiments: Validation'),
      cite('disciplined-entrepreneurship', 'Step 13 (process to acquire a paying customer)'),
    ],
    next: ['pilot-agreement', 'b2b-selling', 'read-results'],
  },
  {
    id: 'prototype',
    title: 'Make a prototype and watch two rounds of 5 people use it',
    stage: 'validation',
    intents: ['prototype'],
    criteria: ['validation-test-card'],
    answer:
      'Make the roughest thing that can answer your one question. To learn if people understand it, draw it on paper. To learn if they can use it, click through three screens. To learn if it works, build only the part that might not work. Show it to five people, give them a task and do not help. Fix what stopped three of them and show it again. Two rounds in two weeks beat one polished version in two months.',
    why: 'Polish makes people polite and makes you slow to change. A rough version invites the truth.',
    steps: [
      step('Write the question the prototype must answer', 'Understand, use or work. Only one.', 10),
      step(
        'Make it in one evening with the simplest tool',
        'Paper, slides, a form, cardboard, a bench test.',
        150,
      ),
      step('Give 5 people a task and stay silent', 'Write where they stop and what they say.', 75),
      step('Fix what stopped 3 or more and repeat with 5 others', 'Leave the rest for later.', 150),
    ],
    doneWhen: 'Two rounds with 5 people each are done, and you can say what stopped them in each round.',
    days: 14,
    template: {
      title: 'Prototype test',
      body: 'Question: [understand / use / work]\nTask I give: "[ ]"\nRound 1: person | finished | stopped at | said\n[ ] | [ ] | [ ] | [ ]\nFixed: [what stopped 3 or more]\nRound 2: person | finished | stopped at | said\n[ ] | [ ] | [ ] | [ ]',
    },
    traps: [
      'Explaining it while they try it.',
      'Testing on people with a health, safety or lab risk without approval from the right office.',
    ],
    referral: null,
    citations: [
      cite('openstax-entrepreneurship', '6.3 Design Thinking'),
      cite('business-model-generation', 'Design: Prototyping'),
      cite('testing-business-ideas', 'Section 3, Experiments: Discovery'),
    ],
    next: ['wizard-of-oz', 'demo', 'read-results'],
  },
  {
    id: 'experiment-design',
    title: 'Write a test card with the number that means it worked',
    stage: 'validation',
    intents: ['experiment-design'],
    criteria: ['validation-test-card'],
    answer:
      'Write five lines before you run anything. We believe this. To check, we will do this. We will measure this number. We are right if it reaches this line. It ends on this date. Choose a pass line you would be embarrassed to argue with later. If you are unsure, ask yourself which result would make you stop. Show the card to one person who wants you to be right and one who does not.',
    why: 'A line set after the result always fits the result. A line set before is what makes it a test.',
    steps: [
      step(
        'Write the belief as something that could be false',
        'Name the person, the action and the amount.',
        15,
      ),
      step('Choose one action to count', 'Paid, booked, returned or signed. Opinions do not count.', 10),
      step(
        'Set the pass line, the number of people and the end date',
        'Use what you would need for the numbers to work. If you do not know, take half of the people you ask, and write why.',
        15,
      ),
      step(
        'Show the card to one supporter and one doubter',
        'Change the line if both say it is too easy.',
        20,
      ),
    ],
    doneWhen: 'The five-line card is written, dated and seen by two people before the test starts.',
    days: 3,
    template: {
      title: 'Test card',
      body: 'We believe that: [person] will [action] because [reason]\nTo check, we will: [test] with [number] people\nWe measure: [one number]\nWe are right if: [pass line]\nEnds on: [date]\nIf we pass, we: [next]\nIf we fail, we: [next]\nSeen by: [name], [name] on [date]',
    },
    traps: [
      'A belief so vague that any result fits it.',
      'Moving the end date because the number is nearly there.',
    ],
    referral: null,
    citations: [
      cite('testing-business-ideas', 'Section 2, Test: Experiment'),
      cite('lean-startup', 'Ch. 4, Experiment'),
      cite('lean-startup', 'Ch. 7, Measure'),
    ],
    next: ['smallest-test', 'read-results', 'pre-sale'],
  },
  {
    id: 'read-results',
    title: 'Write the result next to your line and decide',
    stage: 'validation',
    intents: ['read-results'],
    criteria: ['validation-decision'],
    answer:
      'Put your number next to your line and decide the same day. Above the line, go on and test the next belief. Below it, change one thing, the customer, the offer or the price, and run it once more. Far below it twice means stop this version. If too few people saw it to tell, say so and extend it once with a new end date. Write the decision in one sentence with the number in it.',
    why: 'Results lose their force after a week of explaining. One sentence with a number keeps you honest and lets your mentor help.',
    steps: [
      step('Write the number, the line and how many people it came from', 'No adjectives.', 5),
      step(
        'Write what you saw that the number does not show',
        'Three quotes or moments. Include the ones that hurt.',
        15,
      ),
      step(
        'Choose: go on, change one thing, or stop',
        'Change only one thing, so the next result means something.',
        15,
      ),
      step('Tell one person the decision and the next test date', 'Your EIR, mentor or teammate.', 10),
    ],
    doneWhen: 'One sentence holds the result, the line and the decision, and one other person has read it.',
    days: 2,
    template: {
      title: 'Learning card',
      body: 'We believed: [ ]\nWe saw: [number] of [people], line was [line]\nSurprise: [ ]\nQuotes: "[ ]", "[ ]", "[ ]"\nDecision on [date]: go on / change [one thing] / stop\nNext test: [test] ending [date]',
    },
    traps: [
      'Explaining away a miss with the weather, the exam week or the poster.',
      'Reading a result from five people as if it came from a hundred.',
    ],
    referral: null,
    citations: [
      cite('testing-business-ideas', 'Section 2, Test: Learn'),
      cite('testing-business-ideas', 'Section 2, Test: Decide'),
      cite('lean-analytics', 'Ch. 4, Data-Driven Versus Data-Informed'),
    ],
    next: ['pivot-or-persevere', 'experiment-design', 'unit-economics'],
  },
  {
    id: 'pivot-or-persevere',
    title: 'List your last tests and choose to pivot or go on',
    stage: 'validation',
    intents: ['pivot-or-persevere'],
    criteria: ['validation-decision'],
    answer:
      'Keep going if the last two tests were above your line, or if one was and you know why the other missed. Pivot if two tests in a row were below the line and you changed something in between. A pivot keeps one foot still. Keep what you learned about the customer and change the offer, or keep the offer and change the customer. Change both and you are starting a new idea, which is fine, but call it that.',
    why: 'Pivoting on a feeling throws away learning. Pivoting on two results uses it.',
    steps: [
      step(
        'Put your last tests in one list: belief, line, result',
        'Tests without a line do not count here.',
        20,
      ),
      step(
        'Circle what you are still sure about, with the evidence',
        'A customer, a problem, a channel or a price.',
        15,
      ),
      step(
        'Write the two best options and what each keeps still',
        'For each, the first test and its pass line.',
        30,
      ),
      step(
        'Decide with one outsider and set the next test',
        'Take the list to your EIR or mentor before you announce it to the team.',
        45,
      ),
    ],
    doneWhen:
      'Your tests are listed with lines and results, and the decision and the next test date are written.',
    days: 5,
    template: {
      title: 'Pivot sheet',
      body: 'Tests so far: belief | line | result\n[ ] | [ ] | [ ]\nStill true: [what], because [evidence]\nOption A keeps [ ] and changes [ ]. First test: [ ], line [ ]\nOption B keeps [ ] and changes [ ]. First test: [ ], line [ ]\nDecision on [date]: [A / B / go on]. Told: [names]',
    },
    traps: ['Pivoting every two weeks, so no test ever finishes.'],
    referral: null,
    citations: [
      cite('lean-startup', 'Ch. 8, Pivot (or Persevere)'),
      cite(
        'startup-owners-manual',
        'Ch. 7, Customer Discovery, Phase Four: Verify the Business Model and Pivot or Proceed',
      ),
    ],
    next: ['after-a-pivot', 'experiment-design', 'quit-or-continue'],
  },
  {
    id: 'after-a-pivot',
    title: 'Write the pivot in two sentences and plan its first test',
    stage: 'validation',
    intents: ['after-a-pivot'],
    criteria: ['validation-decision'],
    answer:
      'Three things change, and the rest stays. The old test is closed with its result. The canvas gets new lines only where the pivot touched it, and those lines go back to guess. And the next step becomes the first test of the new belief, with a new pass line and date. What you learned about the customer stays as evidence. Tell your users, your team and your mentor in two sentences this week, so nobody keeps working on the old plan.',
    why: 'A pivot fails when half the team keeps the old plan. Writing what stays and what goes makes it one decision.',
    steps: [
      step(
        'Write the pivot in two sentences: from, to, because of which result',
        'Use the number from the test that decided it.',
        15,
      ),
      step(
        'Go through the canvas and mark stays, changes or unknown',
        'Every line marked changes is a guess again.',
        30,
      ),
      step(
        'Write the first test of the new belief with a pass line',
        'It should finish in one or two weeks.',
        20,
      ),
      step(
        'Tell users, team and mentor, and close what is open',
        'Finish or cancel promises made under the old plan.',
        45,
      ),
    ],
    doneWhen:
      'The two sentences are sent, each canvas line is marked, and the new test has a line and a date.',
    days: 4,
    template: {
      title: 'Pivot note',
      body: 'From: [old plan]\nTo: [new plan]\nBecause: [test], line [ ], result [ ]\nStays: [customer, problem, people, tools]\nChanges: [lines of the canvas]\nOpen promises: [to whom], done or cancelled by [date]\nFirst new test: [ ], pass line [ ], ends [date]\nTold: users [ ], team [ ], mentor [ ]',
    },
    traps: ['Keeping old promises alive because ending them is awkward.'],
    referral: null,
    citations: [
      cite('lean-startup', 'Ch. 8, Pivot (or Persevere)'),
      cite('testing-business-ideas', 'Section 2, Test: Manage'),
      ain(AIN.canvas),
    ],
    next: ['experiment-design', 'find-ten-people', 'business-model-canvas'],
  },
  {
    id: 'patent-now-or-wait',
    title: 'List what you have shown and book UR Ventures about a patent',
    stage: 'validation',
    intents: ['patent-now-or-wait', 'going-public-said'],
    criteria: [],
    answer:
      'Do not file or wait on your own. Talk to UR Ventures first, and do it before you show how it works to anyone. I am not a lawyer, and this is orientation. The reason for the rush is disclosure. In the United States a public disclosure starts a one-year clock, and in other countries it can end your rights. A provisional application holds a date for 12 months and cannot be extended. A patent professional must decide. Meanwhile, test demand by talking about the result, not the method.',
    why: 'Timing depends on who owns it, what has been shown and whether a patent would help at all. Those are facts a professional must weigh.',
    steps: [
      step(
        'List every time the invention was shown, written or sold',
        'Posters, theses, demos, posts, emails without a secrecy agreement. Include dates.',
        30,
      ),
      step(
        'Stop showing how it works until you have advice',
        'You can still ask customers about the problem and the result.',
        5,
      ),
      step(
        'Contact UR Ventures and say a disclosure date may be near',
        'Name the next talk, class, deadline or publication.',
        15,
      ),
      step(
        'Write three facts for the meeting',
        'What is new, who would pay because of it, and what you would do if you could not protect it.',
        30,
      ),
    ],
    doneWhen:
      'Your list of disclosures is written, and a meeting with UR Ventures or a patent professional has a date.',
    days: 5,
    template: {
      title: 'Patent meeting sheet',
      body: 'What is new, in two lines for the professional only: [ ]\nMade by: [names], in [lab or place], paid by [source]\nShown so far: what | to whom | date | was it secret?\n[ ] | [ ] | [ ] | [ ]\nComing up: [talk, poster, paper, pitch] on [date]\nWho would pay because of it: [ ]\nMy questions: Who owns it? Can it still be protected? Is it worth it?',
    },
    traps: [
      'Pitching the method at a competition before asking.',
      'Filing on your own to save money and leaving out what matters.',
    ],
    referral: REFERRALS.urVentures(
      'Your list of disclosures with dates, who was involved, the funding, and the next date when it would be shown.',
    ),
    citations: [cite('uspto-provisional'), cite('ur-ip-policy'), cite('uspto-basics')],
    next: ['student-ip', 'share-the-idea', 'biotech-path'],
  },
  {
    id: 'regulated-data',
    title: 'List the data you touch and ask the right office',
    stage: 'validation',
    intents: ['regulated-data'],
    criteria: [],
    answer:
      'Do not collect it yet. First find out which rules apply, because health records, student records and research with people each have their own. I am not a lawyer, and this is orientation. Health rules follow who you work for: health plans and most care providers are covered, and you can come under them by working for one. Student records have a federal privacy law. Research on people at the University goes through its review board. Run your first test with made-up data, and ask before real data moves.',
    why: 'Data taken the wrong way cannot be untaken. A made-up set shows whether the product is useful without putting anyone at risk.',
    steps: [
      step(
        'List every kind of data you would touch and where it comes from',
        'Names, health, grades, location, payment, minors, recordings.',
        20,
      ),
      step('Cross out what the first test does not need', 'Most first tests need no real names.', 10),
      step(
        'Make a set of invented records and test with that',
        'At least 10 rows that look real and belong to nobody.',
        60,
      ),
      step(
        'Ask the right office before any real record',
        'Your EIR can point to a lawyer, the Office for Human Subject Protection or the hospital privacy office.',
        30,
      ),
    ],
    doneWhen:
      'You have a data list, the first test runs on invented records, and the right office has your question.',
    days: 7,
    template: {
      title: 'Data list for the specialist',
      body: 'Data | About whom | From where | Needed for the first test? | Kept how long\n[ ] | [ ] | [ ] | [yes/no] | [ ]\nWho I would work for: [hospital, school, company, the public]\nIs it research on people? [yes / no / not sure]\nMy question: [one sentence]',
    },
    traps: [
      'Copying real records into a tool to make a demo.',
      'Believing that removing the name makes it safe.',
    ],
    referral: {
      category: 'legal',
      role: 'specialist',
      who: 'A privacy lawyer; for research with people, the Office for Human Subject Protection',
      bring:
        'Your data list, who you would work for, whether it is research, and where the data would be stored.',
    },
    citations: [cite('hhs-hipaa'), cite('ed-ferpa'), cite('ur-ohsp')],
    next: ['biotech-path', 'prototype', 'contracts-and-insurance'],
  },
  {
    id: 'medical-rules',
    title: 'Write the intended use and book a regulatory specialist',
    stage: 'validation',
    intents: ['medical-rules'],
    criteria: [],
    answer:
      'Write the intended use in one sentence and take it to a regulatory specialist. That sentence decides the path. I cannot tell you which path applies, and this is orientation. For a device, the FDA steps start with the class of the device, then the right submission, then review, then ongoing controls. Some devices are exempt and some need clinical evidence. A drug has its own process. Until you have advice, do not claim that it treats, diagnoses or prevents anything.',
    why: 'Small changes in wording can move a product to a different path. Asking early saves a redesign, and a claim made too soon can cause real harm.',
    steps: [
      step(
        'Write the intended use: what it does, on whom, used by whom, where',
        'Leave out marketing words. Read it to a clinician.',
        30,
      ),
      step(
        'Read the FDA page for your type and write 3 questions',
        'Device, drug or software. Do not choose the class yourself.',
        45,
      ),
      step(
        'Find the two closest products already on the market',
        'Note how they describe themselves. A specialist will ask.',
        45,
      ),
      step(
        'Book a specialist through UR Ventures or your EIR',
        'Send the sentence, the questions and the two products.',
        15,
      ),
    ],
    doneWhen:
      'The intended use is one sentence, 3 questions are written, and a specialist has a meeting date.',
    days: 10,
    template: {
      title: 'Regulatory one-pager',
      body: 'Intended use: [product] is for [purpose] in [patients or samples], used by [who] in [where].\nIt does not: [what you do not claim]\nClosest products: [name, how it is described], [name, how it is described]\nData so far: [bench, animal, none]\nQuestions: 1 [ ]  2 [ ]  3 [ ]',
    },
    traps: ['Testing on people before the review board and a specialist have said how.'],
    referral: REFERRALS.regulatory(
      'The intended use in one sentence, the closest products, the data so far and your three questions.',
    ),
    citations: [cite('fda-devices'), cite('fda-drugs'), cite('ur-ohsp')],
    next: ['biotech-path', 'student-ip', 'regulated-data'],
  },
  {
    id: 'pilot-agreement',
    title: 'Get a one-page pilot signed, with a price and an end date',
    stage: 'validation',
    intents: ['pilot-agreement'],
    criteria: ['validation-commitment', 'sales-ten-customers'],
    answer:
      'Make the pilot short, paid and with an end. Aim for six weeks, one team and one number that both sides agree on. Put one line in writing: if the number is reached, they buy at this price. Charge something, even if it is less than your full price. A free pilot is easy to ignore. Write it on one page and have a lawyer read it before you sign. The parts on data, liability and who owns what matter most.',
    why: 'A pilot without a success line or an end becomes free work. The decision rule turns it into a sale or a clear no.',
    steps: [
      step(
        "Agree the one number and today's value of it",
        'Hours, errors, orders. Measure it before you start.',
        45,
      ),
      step(
        'Write the one-page pilot with scope, dates, price and the buy line',
        'Name who does what on their side.',
        45,
      ),
      step(
        'Get a legal read, then both sides sign',
        'Ask about data, liability, ownership and how either side can end it.',
        60,
      ),
      step(
        'Book the midpoint and the decision meeting now',
        'Invite the person with the budget to the second one.',
        10,
      ),
    ],
    doneWhen:
      'A one-page pilot is signed with a price, a number, an end date and the decision meeting booked.',
    days: 21,
    template: {
      title: 'One-page pilot, draft for legal review',
      body: 'Between: [company] and [venture]\nGoal: move [number] from [today] to [target] by [date]\nScope: [team, number of users, what is included, what is not]\nDates: start [ ], midpoint [ ], decision meeting [ ]\nPrice: [ ], paid [when]\nThey provide: [person, data, access]\nIf the goal is met: [company] buys [what] at [price] from [date]\nEither side may end it by: [ ]\nData, liability, ownership: [for the lawyer]',
    },
    traps: [
      'A pilot with the fan who loves you and nobody with a budget.',
      'Building something special for one pilot that no one else will buy.',
    ],
    referral: REFERRALS.lawyer(
      'The one-page draft, what data you would touch, who is liable if it fails, and anything their side asked you to sign.',
    ),
    citations: [
      cite('mom-test', 'Ch. 5, Commitment and Advancement'),
      cite('disciplined-entrepreneurship', 'Step 13 (process to acquire a paying customer)'),
      cite('sba-manage', 'Stay legally compliant'),
    ],
    next: ['b2b-selling', 'first-ten-customers', 'contracts-and-insurance'],
  },
  {
    id: 'hardware-first-units',
    title: 'Sell the first batch and make 5 units with a cost log',
    stage: 'validation',
    intents: ['hardware-first-units'],
    criteria: ['validation-commitment'],
    answer:
      'Sell it before you make a mold. Make one that works and one that looks right, even if they are two different things. Show both to ten buyers and take paid orders for a first batch of about twenty. Make that batch by hand, in the makerspace or at a small shop. Write the real cost of each unit while you do it. Only then ask a manufacturer for a quote, with a drawing and a count. Orders first, tooling last.',
    why: 'Tooling freezes the design and takes cash. A hand-made batch finds the mistakes and the true cost while they are still easy to change.',
    steps: [
      step(
        'Make one that works and one that looks right',
        'Cardboard, print or parts from a shop. Test safety with someone who knows.',
        300,
      ),
      step(
        'Show both to 10 buyers and take paid orders for a batch of 20',
        'With a date and a full refund if you miss it.',
        180,
      ),
      step(
        'Make 5 by hand and write time, parts and failures',
        'For each unit. The fifth one shows the real time.',
        300,
      ),
      step(
        'Ask 3 makers for a quote with a drawing and a count',
        'Ask about setup, smallest batch, lead time and what they would change.',
        90,
      ),
    ],
    doneWhen:
      'Paid orders for the first batch are counted, 5 units have a cost log, and 3 quotes are asked for.',
    days: 30,
    template: {
      title: 'Unit log and quote request',
      body: 'Unit | Parts cost | Minutes | Failed at | Fixed by\n[ ] | [ ] | [ ] | [ ] | [ ]\nOrders paid: [ ]  Promised date: [ ]\nQuote request: "We make [product]. Drawing attached. We need [count] by [date]. What are setup, price per unit, smallest batch and lead time? What would you change to make it simpler?"',
    },
    traps: [
      'Ordering a large batch to get a low unit price.',
      'Electrical, medical, child or food-contact items without a safety review.',
    ],
    referral: null,
    citations: [
      cite('testing-business-ideas', 'Section 3, Experiments: Validation'),
      cite('business-model-generation', 'Design: Prototyping'),
      cite('openstax-entrepreneurship', '12.3 Designing a Startup Operational Plan'),
    ],
    next: ['unit-economics', 'pre-sale', 'contracts-and-insurance'],
  },
];
