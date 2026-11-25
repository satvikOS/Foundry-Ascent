import type { Play } from '@foundry/contracts';

import { AIN, REFERRALS, ain, cite, step } from '../make.js';

export const GROWTH_PLAYS: readonly Play[] = [
  {
    id: 'retention',
    title: 'Find out why customers leave',
    stage: 'growth',
    intents: ['retention'],
    criteria: ['growth-customers-stay'],
    answer:
      'Stop adding new customers for two weeks and call five who left. Ask what they used it for, when they stopped and what they use now. Then take one group who started in the same week and count how many were still with you four weeks later. If fewer than half stayed, the product or the promise is wrong, and more marketing makes it worse. Fix the first thing that three of the five name, and measure the next group the same way.',
    why: 'New customers hide a leak. Looking at one group over time shows whether you are building a business or filling a bucket.',
    steps: [
      step(
        'Pick everyone who started in one week and count who is still active',
        'Write what active means: bought, used or returned.',
        30,
      ),
      step(
        'Call 5 who stopped',
        'What were you hoping for? What happened the last time you used it? What do you use now?',
        75,
      ),
      step('Call 3 who stayed', 'What would you miss? Who else has that need?', 45),
      step(
        'Fix the first thing 3 people named and repeat with the next group',
        'One change. Same count after 4 weeks.',
        240,
      ),
    ],
    doneWhen:
      'One starting group has a count after 4 weeks, 8 customers have been called, and one fix is live.',
    days: 28,
    template: {
      title: 'Starting group',
      body: 'Started in week of: [date]  Number: [ ]  Active means: [ ]\nAfter week 1 [ ]  2 [ ]  3 [ ]  4 [ ]\nLeft: name | hoped for | stopped when | uses now\n[ ] | [ ] | [ ] | [ ]\nStayed: name | would miss\n[ ] | [ ]\nFix: [ ], because [count] said it. Next group starts [date].',
    },
    traps: [
      'An average over all customers. It hides the new ones leaving.',
      'A discount to people who left for another reason.',
    ],
    referral: null,
    citations: [
      cite('lean-analytics', 'Ch. 5, Analytics Frameworks'),
      cite('lean-startup', 'Ch. 7, Measure'),
      cite('competing-against-luck', "Ch. 5, How to Hear What Your Customers Don't Say"),
    ],
    next: ['one-metric', 'scaling-readiness', 'after-a-pivot'],
  },
  {
    id: 'scaling-readiness',
    title: 'Check if you are ready to scale',
    stage: 'growth',
    intents: ['scaling-readiness'],
    criteria: ['growth-repeatable'],
    answer:
      'Scale when five things are true, not when you feel busy. Strangers buy every week from one channel. They come back. One sale leaves money after the cost of winning the customer. Someone other than you can sell and deliver it from a written page. And you have cash for the gap between spending and getting paid. Any no on that list is your next month. Adding people or places before that multiplies the problem, not the result.',
    why: 'Growth makes whatever you have bigger, also the losses. A written way of working is what lets others repeat it.',
    steps: [
      step(
        'Answer the five questions with a number or a name',
        'Leave it blank if you have none. Blank means no.',
        30,
      ),
      step(
        'Write how you sell and deliver on one page each',
        'Steps, words that work, what goes wrong.',
        120,
      ),
      step(
        'Have someone else sell and deliver one using only the pages',
        'Watch, do not help. Fix the page.',
        180,
      ),
      step(
        'Work out the cash for twice the sales',
        'What do you pay before you are paid? Put it in the forecast.',
        45,
      ),
    ],
    doneWhen:
      'Five answers have evidence, and someone else has sold and delivered once from your written pages.',
    days: 28,
    template: {
      title: 'Scale check',
      body: '1 Sales to strangers, last 4 weeks, from [channel]: [ ] [ ] [ ] [ ]\n2 Still active after 4 weeks: [ ] of [ ]\n3 Left per customer after winning cost: [ ]\n4 Sold and delivered by someone else: [name, date]\n5 Cash for twice the sales: need [ ], have [ ]\nFirst no: [number]. I fix it by: [ ] on [date]',
    },
    traps: [
      'Hiring to solve a problem you have not written down.',
      'A second city before the first one works without you.',
    ],
    referral: null,
    citations: [
      cite('openstax-entrepreneurship', '10.5 Growth: Signs, Pains, and Cautions'),
      cite('high-growth-handbook', 'Ch. 5, Organizational structure and hypergrowth'),
      ain(AIN.mindset2),
    ],
    next: ['hiring', 'runway', 'second-group'],
  },
  {
    id: 'hiring',
    title: 'Make your first hire',
    stage: 'growth',
    intents: ['hiring'],
    criteria: ['growth-repeatable'],
    answer:
      'Hire only for work you already do, know how to do well, and can no longer fit in. Write what that person will have done in 90 days, and try a paid project of two weeks before any long promise. Choose by work you saw, and ask each person the same questions. Check whether they count as an employee or a contractor before you pay, because the rules differ and a mistake is costly. Get advice on that part. Friends are fine only if they pass the same test.',
    why: 'A hire made to escape a mess inherits the mess. A small paid project shows more than any interview.',
    steps: [
      step(
        'Write the 90-day result and the hours it takes you now',
        'Three lines. If you cannot, you are not ready.',
        30,
      ),
      step(
        'Read the SBA page on hiring, and ask about employee or contractor',
        'Also ask about campus and visa rules for student workers.',
        45,
      ),
      step('Give 2 people a paid project of two weeks', 'Same task, same price, same deadline.', 120),
      step('Ask both the same 5 questions and decide', 'About past work, not about the future.', 60),
    ],
    doneWhen:
      'A 90-day result is written, 2 people did a paid project, and the employee question has an answer.',
    days: 28,
    template: {
      title: 'First hire',
      body: 'Work I do now: [ ], [hours] a week\nIn 90 days this person has: 1 [ ] 2 [ ] 3 [ ]\nPaid project: [task], [price], due [date]\nQuestions to all: 1 Tell me about the last time you [work]. 2 What went wrong? 3 How did you know it was good? 4 What did you learn on your own? 5 What do you want from this?\nEmployee or contractor: asked [who], answer [ ]\nCan we pay for 6 months? [cash] / [monthly cost] = [months]',
    },
    traps: [
      'Paying people with promises of shares and no paper.',
      "Unpaid interns doing the company's work.",
    ],
    referral: REFERRALS.lawyer(
      'The role, the hours, who directs the work, the pay, where they live and whether they are a student on a visa.',
    ),
    citations: [
      cite('high-growth-handbook', 'Ch. 3, Recruiting, hiring, and managing talent'),
      cite('founders-dilemmas', 'Hiring Dilemmas'),
      cite('sba-manage', 'Hire and manage employees'),
    ],
    next: ['runway', 'scaling-readiness', 'cofounder-agreement'],
  },
  {
    id: 'second-group',
    title: 'Expand to a second group',
    stage: 'growth',
    intents: ['second-group'],
    criteria: ['growth-repeatable'],
    answer:
      'Stay until the first group buys without you pushing, then take the group next door. Next door means they know people in the first group, or they use the product the same way. Do five interviews there first, as if it were new, because it is. Test one price and one message with ten of them. Keep at least half of your time on the first group. If the new group needs a different product, it is a new venture, and you treat it as one.',
    why: 'Word travels across a short distance. A group far away makes you small and unknown again, with two products to look after.',
    steps: [
      step(
        'Check that the first group brings customers without you',
        'Referrals or returns in the last 4 weeks.',
        15,
      ),
      step(
        'List 3 groups next door and what they share with the first',
        'People, place, use or supplier.',
        20,
      ),
      step(
        'Hold 5 interviews and offer it to 10 in the best one',
        'New notes. Do not reuse the old ones.',
        240,
      ),
      step(
        'Compare sales per hour with the first group and decide',
        'Below half of it means go back to the first group.',
        20,
      ),
    ],
    doneWhen: '5 interviews and 10 offers in the new group are done, and sales per hour are compared.',
    days: 28,
    template: {
      title: 'Next door',
      body: 'First group: referrals or returns in 4 weeks [ ]\nGroup | Shares with the first | Differs in | 5 talks say | 10 offers: yes\n[ ] | [ ] | [ ] | [ ] | [ ]\nSales per hour: first [ ], new [ ]\nDecision on [date]: go / wait / different product',
    },
    traps: ['Leaving the first group because the new one is more exciting.'],
    referral: null,
    citations: [
      cite('crossing-the-chasm', 'Ch. 4, Target the Point of Attack'),
      cite('disciplined-entrepreneurship', 'Step 14 (follow-on markets)'),
      cite('innovators-dilemma', 'Ch. 7, Discovering New and Emerging Markets'),
    ],
    next: ['beachhead', 'market-size', 'scaling-readiness'],
  },
  {
    id: 'runway',
    title: 'Know how many months you can run',
    stage: 'growth',
    intents: ['runway'],
    criteria: ['model-money-needed'],
    answer:
      'Divide the cash you have by the cash you lose in a normal month. That is your runway in months. Use the last three real months, not the plan. Under six months, stop new spending today and pick two things: collect what customers owe you, and raise or presell. Look at it on the first day of each month. Cash is not the same as sales. Money you are owed does not pay a bill.',
    why: 'Ventures stop when the cash ends, also when customers like them. A number you check each month gives you time to choose.',
    steps: [
      step('Write the cash in all accounts today', 'Not what is owed to you.', 10),
      step('Average the last 3 months of cash out minus cash in', 'From your bank sheet.', 20),
      step('Divide, and list 3 costs you could stop this week', 'Subscriptions, stock, events.', 20),
      step('Chase money owed and ask 3 customers to prepay', 'Call, do not email.', 45),
    ],
    doneWhen: 'Your runway in months is written, 3 costs are marked, and money owed has been chased.',
    days: 3,
    template: {
      title: 'Runway',
      body: 'Cash today: [ ]\nCash out - cash in: month 1 [ ], month 2 [ ], month 3 [ ], average A = [ ]\nRunway: cash / A = [months]\nCan stop: [ ], [ ], [ ]\nOwed to me: [who, amount, since]\nNext check: first of [month]',
    },
    traps: ['Counting a grant or a sale before the money arrives.'],
    referral: null,
    citations: [
      cite('openstax-entrepreneurship', '9.3 Accounting Basics for Entrepreneurs'),
      cite('sba-manage', 'Manage your finances'),
    ],
    next: ['financial-forecast', 'grants-angels-vc', 'break-even'],
  },
  {
    id: 'raise-or-grow',
    title: 'Decide to raise money or grow on sales',
    stage: 'growth',
    intents: ['raise-or-grow'],
    criteria: ['growth-plan'],
    answer:
      'Grow on sales unless one thing is true: there is a window that closes, and your own numbers show that money now captures it. If more cash would not bring customers faster, do not give up shares for it. If it would, show it: this much in, this many customers, this much left per customer, from results you already have. The old saying is that a small part of something large can be worth more than most of something small. That holds only if the money makes it large.',
    why: 'The programme takes the middle view and points to unit economics for the decision. Money speeds up what works. It does not find what works.',
    steps: [
      step(
        'Write what would be gone in a year if you go slowly, and the evidence',
        'A deal, a place, a rival who wins a customer you lost.',
        20,
      ),
      step(
        'Work out what one more unit of money brings, from your channel test',
        'Customers won, left per customer, months to get it back.',
        30,
      ),
      step(
        'Plan both ways for a year',
        'Sales only, and with money. Compare customers, cash and what you own.',
        60,
      ),
      step('Take both plans to your EIR', 'Ask which assumption they believe least.', 45),
    ],
    doneWhen: 'Both one-year plans are written from your own numbers, and your EIR has challenged them.',
    days: 10,
    template: {
      title: 'Raise or grow',
      body: 'Window: [what closes], by [date], evidence [ ]\nMy numbers: spend [ ] wins [ ] customers, each leaves [ ], back in [months]\nPlan A, sales only: customers [ ], cash low point [ ], we own [ ]\nPlan B, with [amount]: customers [ ], cash low point [ ], we own [ ]\nBelieved least: [ ]\nDecision on [date]: [ ]',
    },
    traps: ['Raising because others in your cohort did.'],
    referral: REFERRALS.securities(
      'Both one-year plans, your one-sale table, who you would ask and how much.',
    ),
    citations: [
      ain(AIN.mindset2),
      ain(AIN.fundraising),
      cite('innovators-solution', 'Ch. 9, There Is Good Money and There Is Bad Money'),
      cite('founders-dilemmas', 'Wealth-versus-Control Dilemmas'),
    ],
    next: ['grants-angels-vc', 'valuation', 'bootstrapping'],
  },
  {
    id: 'ain-plan-capstone',
    title: 'Write the plan for the Module 3 capstone',
    stage: 'growth',
    intents: ['ain-plan-capstone'],
    criteria: ['growth-plan'],
    answer:
      'Write it from evidence you already have, in the order a reader asks. What we do and for whom. Proof that they pay. The market, counted from the bottom up. How we reach them. Money in one sale. The team. What we need and what it will prove. Two pages of proof beat twenty of hope. Put a source or the word guess next to every number. Check the current format and due date on Blackboard, because the programme changes as it goes.',
    why: 'A plan is worth writing because it makes you join the pieces. The reader looks for the number with no source.',
    steps: [
      step(
        'Read the current instructions on Blackboard',
        'Length, parts, due date, whether an evaluation of the opportunity is asked for.',
        10,
      ),
      step(
        'Collect your canvas, interview table, test cards, one-sale table and forecast',
        'These are the plan. The text only joins them.',
        45,
      ),
      step('Write one page a day for a week', 'Plain sentences. No paragraph without a fact.', 300),
      step(
        'Have a mentor and a doubter mark every number they do not believe',
        'Add a source, a guess mark or a new test.',
        60,
      ),
    ],
    doneWhen: 'The plan is submitted, and every number in it has a source or the word guess.',
    days: 14,
    template: {
      title: 'Business plan from evidence',
      body: '1 Summary: we [do what] for [whom], and [proof]\n2 Problem and customer: [interview table, count, quotes]\n3 Offer and value: [sentence customers repeat]\n4 Proof: [test cards with line and result]\n5 Market: [bottom-up count, source]\n6 Competition: [alternatives table]\n7 Reaching customers: [channel, hours per customer]\n8 Money: [one-sale table, break-even, 12-month cash]\n9 Team and gaps: [roles page]\n10 Risks: [what must still be true, next test]\n11 Ask: [what, to prove what, by when]\nEach number: [source] or guess',
    },
    traps: ['Writing the summary first. Write it last.'],
    referral: null,
    citations: [
      cite('ain-curriculum', 'Module 3 capstone: The Business Plan'),
      cite('sba-plan', 'Write your business plan'),
      cite('openstax-entrepreneurship', '11.4 The Business Plan'),
    ],
    next: ['financial-forecast', 'leaving-ain', 'market-size'],
  },
];
