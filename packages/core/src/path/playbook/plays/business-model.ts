import type { Play } from '@foundry/contracts';

import { AIN, REFERRALS, ain, cite, step } from '../make.js';

export const BUSINESS_MODEL_PLAYS: readonly Play[] = [
  {
    id: 'business-model-canvas',
    title: 'Fill the nine boxes of the Business Model Canvas',
    stage: 'business_model',
    intents: ['business-model-canvas'],
    criteria: ['model-canvas'],
    answer:
      'Fill the two right-hand boxes first: one customer group and the value you give them. Then how they reach you and how you get paid. Then what you must do, have and buy to deliver it. Nine boxes, one group, sticky notes of five words or less. Mark each note proven or guess. The canvas is finished when you can point to the three guesses that would break it, and those become your next three tests.',
    why: 'The programme calls it a one-page dashboard and a living document. It is useful as a list of guesses to check, not as a poster.',
    steps: [
      step(
        'Fill customer, value, channel, relationship and revenue for one group',
        'Use words from your interviews and your price test.',
        40,
      ),
      step(
        'Fill activities, resources, partners and costs',
        'Only what you need for the next 10 customers.',
        30,
      ),
      step('Mark every note proven or guess', 'Proven means someone paid, signed or did it.', 15),
      step(
        'Circle the 3 guesses that would break it and date a test for each',
        'Start with the customer side.',
        15,
      ),
    ],
    doneWhen:
      'Nine boxes are filled for one group, each note is marked, and 3 guesses have a test with a date.',
    days: 5,
    template: {
      title: 'Business Model Canvas, one group',
      body: 'Customer group: [ ] (proven/guess)\nValue: [ ] (p/g)\nChannels: how they find, buy and get it: [ ] (p/g)\nRelationship: how you keep them: [ ] (p/g)\nRevenue: who pays, for what, how, how often: [ ] (p/g)\nActivities: [ ] (p/g)\nResources: people, skills, tools, data: [ ] (p/g)\nPartners: [ ] (p/g)\nCosts: one-time, monthly, per sale: [ ] (p/g)\nThree guesses to test: 1 [ ] by [date]  2 [ ] by [date]  3 [ ] by [date]',
    },
    traps: [
      'Two customer groups mixed in one canvas. Use one color or one canvas for each.',
      'Filling it once and never opening it again.',
    ],
    referral: null,
    citations: [
      cite('business-model-generation', 'Canvas'),
      ain(AIN.canvas),
      cite('openstax-entrepreneurship', '11.2 Designing the Business Model'),
    ],
    next: ['ain-canvas-capstone', 'revenue-model', 'unit-economics'],
  },
  {
    id: 'ain-canvas-capstone',
    title: 'Submit your canvas for the Module 1 capstone',
    stage: 'business_model',
    intents: ['ain-canvas-capstone'],
    criteria: ['model-canvas'],
    answer:
      'Submit a canvas that shows what you know and what you are still guessing. Use one customer group, keep each note short, and back the customer, value and revenue boxes with something real: interviews, orders or a price test. Have one mentor and one customer read it before you hand it in. Check the current instructions and due date on Blackboard, because the programme changes as it goes.',
    why: 'A canvas full of guesses looks like everyone else. Three boxes with evidence look like a venture.',
    steps: [
      step(
        'Read the current instructions on Blackboard and note the due date',
        'Format, file type and what must be attached.',
        10,
      ),
      step(
        'Update your canvas from your last interviews and tests',
        'Replace guesses with counts where you have them.',
        45,
      ),
      step('Have one mentor and one customer read it', 'Ask each which box they believe least.', 45),
      step(
        'Fix the two weakest boxes and submit two days early',
        'Keep a copy with the date in its name.',
        30,
      ),
    ],
    doneWhen: 'The canvas is submitted, with evidence in the customer, value and revenue boxes.',
    days: 10,
    template: {
      title: 'Capstone check',
      body: 'One customer group: yes / no\nCustomer box backed by: [number] interviews\nValue box backed by: [quote or result]\nRevenue box backed by: [price test or orders]\nCost box uses: [my own numbers]\nMentor read it: [name, date]. Weakest box: [ ]\nCustomer read it: [name, date]. Weakest box: [ ]\nDue: [date from Blackboard]',
    },
    traps: ['Writing the canvas the night before from memory.'],
    referral: null,
    citations: [
      cite('ain-curriculum', 'Module 1 capstone: Business Model Canvas'),
      ain(AIN.canvas),
      cite('business-model-generation', 'Strategy: Evaluating Business Models'),
    ],
    next: ['revenue-model', 'unit-economics', 'elevator-pitch'],
  },
  {
    id: 'service-or-product',
    title: 'Write one fixed offer and ask 3 customers to buy it',
    stage: 'business_model',
    intents: ['service-or-product'],
    criteria: ['model-canvas'],
    answer:
      'Both, in this order. Sell it as a fixed service first, then turn the part that repeats into your software. Do not start with open-ended consulting by the hour, and do not start with software. Take one job that companies already pay someone to do, offer it at a fixed price with a fixed result, and deliver it by hand for three customers. The steps that were the same for all three become the product. The steps that were different stay a service, or go.',
    why: 'A service pays you while you learn how the work is really done. Software built before that fixes the wrong steps in place.',
    steps: [
      step(
        'Choose one job with a clear start and end',
        'For example one report, one form or one process, for one kind of company.',
        20,
      ),
      step(
        'Write the fixed offer: result, time, price, what is not included',
        'One page. The limits are what make it repeatable.',
        40,
      ),
      step(
        'Sell it to 3 customers of the same kind',
        'Same offer each time. Write down every extra thing they ask for.',
        240,
      ),
      step(
        'Mark each delivery step same or different',
        'Automate the same step that takes longest. Keep a person on the rest.',
        40,
      ),
    ],
    doneWhen:
      'The fixed offer is on one page, 3 similar customers were asked to buy it, and the steps are marked.',
    days: 28,
    template: {
      title: 'Fixed service offer',
      body: 'For: [one kind of company]\nJob: [what is done today by whom]\nResult: [what they have at the end]\nTime: [days]  Price: [fixed price], paid [half at the start, half at the end, or your terms]\nNot included: [ ], [ ]\nThey provide: [data, one contact person]\nSteps I do: 1 [same/different] 2 [same/different] 3 [same/different]\nFirst step to automate: [ ]',
    },
    traps: [
      'A new custom project for each customer. That is a job, not a product.',
      'Touching company records or money without an agreement on data and liability.',
    ],
    referral: null,
    citations: [
      cite('disciplined-entrepreneurship', 'Step 15 (business model)'),
      cite('lean-startup', 'Ch. 6, Test'),
      ain(AIN.businessModel),
    ],
    next: ['concierge-test', 'b2b-selling', 'pricing'],
  },
  {
    id: 'revenue-model',
    title: 'Choose one way of getting paid and try it on 5 customers',
    stage: 'business_model',
    intents: ['revenue-model'],
    criteria: ['model-canvas'],
    answer:
      'Choose the one that follows how your customer gets value. Value once: charge once. Value every month: subscription. Value per use: charge per use. Value when two sides meet: take a fee on each deal. Free for users and paid by others works only with a lot of attention, so it is rarely right for a first venture. Start with the simplest one that gets cash in before your costs go out, and change it later with evidence.',
    why: 'The programme asks how you give value and how you get paid for it. When the payment follows the value, the price is easy to explain.',
    steps: [
      step(
        'Write when your customer gets the value: once, monthly, per use, per deal',
        'Use what you saw in your test, not what you would like.',
        15,
      ),
      step(
        'List how they pay for the closest thing today',
        'People accept a familiar way of paying faster.',
        20,
      ),
      step(
        'Pick one and write the cash timeline for one sale',
        'When you spend, when you deliver and when the money arrives.',
        20,
      ),
      step(
        'Offer it to 5 customers and write their reactions',
        'Ask whether the way of paying, not only the price, is a problem.',
        60,
      ),
    ],
    doneWhen:
      'One way of getting paid is chosen, the cash timeline is written, and 5 customers have reacted to it.',
    days: 7,
    template: {
      title: 'Revenue choice',
      body: 'Value arrives: once / monthly / per use / per deal\nThey pay today for [closest thing] by [how]\nMy choice: [one-time / subscription / per use / fee per deal / license / ads or sponsor]\nCash for one sale: spend [amount] on [day], deliver on [day], receive [amount] on [day]\nReactions from 5: [ ]',
    },
    traps: [
      'Subscriptions for something people need twice a year.',
      'Five ways of getting paid on one slide.',
    ],
    referral: null,
    citations: [
      ain(AIN.mindset2),
      ain(AIN.businessModel),
      cite('business-model-generation', 'Patterns'),
      cite('lean-analytics', 'Ch. 7, What Business Are You In?'),
    ],
    next: ['pricing', 'unit-economics', 'business-model-canvas'],
  },
  {
    id: 'pricing',
    title: 'Set a first price and say it to 5 buyers',
    stage: 'business_model',
    intents: ['pricing'],
    criteria: ['model-price'],
    answer:
      'Price from what the customer uses now, not from your costs. Find what their current way costs them in money and time. Set your price below that cost and above what one sale costs you. That is your range. Start nearer the top, because lowering a price is easier than raising it. Say it out loud to five buyers this week and do not explain. If nobody blinks, you are too low. If everyone walks away, ask what they would compare it with.',
    why: 'Customers judge a price against their alternative. Your costs only tell you the floor, below which you lose money on each sale.',
    steps: [
      step(
        'Write what the current way costs 3 customers',
        'Money they spend and hours they lose. Use their own figures.',
        45,
      ),
      step(
        'Write what one sale costs you: the floor',
        'Materials, fees, delivery and a fair rate for your time.',
        20,
      ),
      step(
        'Choose one price between the two, nearer the top',
        'One price, no menu. Write why a customer still wins.',
        10,
      ),
      step(
        'Say it to 5 buyers and log each reaction',
        'Yes, no, pause, or a counter-offer, with their words.',
        75,
      ),
    ],
    doneWhen:
      'A floor, a ceiling and one price are written, and 5 buyers have heard it, with reactions logged.',
    days: 7,
    template: {
      title: 'First price',
      body: 'Current way costs them: [money] + [hours] x [their hourly value] = [ceiling]\nOne sale costs me: [materials] + [fees] + [delivery] + [my time] = [floor]\nMy price: [price], between [floor] and [ceiling]\nThey still win because: [ ]\nBuyer | reaction | their words\n[ ] | [yes/no/pause] | "[ ]"',
    },
    traps: [
      'Copying a big company price. Their costs and customers are not yours.',
      'A student discount before anyone has refused the full price.',
    ],
    referral: null,
    citations: [
      cite('disciplined-entrepreneurship', 'Step 16 (pricing framework)'),
      cite('openstax-entrepreneurship', '8.1 Entrepreneurial Marketing and the Marketing Mix'),
    ],
    next: ['price-test', 'unit-economics', 'revenue-model'],
  },
  {
    id: 'price-test',
    title: 'Offer two prices to 10 buyers each',
    stage: 'business_model',
    intents: ['price-test'],
    criteria: ['model-price'],
    answer:
      'Offer one price to ten real buyers this week and count who pays. Next week, offer a higher price to ten other buyers like them. Keep the one that leaves more money in total after your costs, not the one with the most yeses. Do not show two prices to people who talk to each other, and keep every price you promised. If both prices sell the same, the higher one is right.',
    why: 'People cannot tell you what they would pay, and they are very clear when asked to. Two small groups show what a price does.',
    steps: [
      step(
        'Choose price A and price B, both above your floor',
        'Make B clearly higher, so the difference can show.',
        15,
      ),
      step(
        'Offer A to 10 buyers and B to 10 similar buyers',
        'Same words, same place, different week or location.',
        180,
      ),
      step(
        'Fill the table and compute money left for each price',
        'Paid, times what is left from one sale.',
        20,
      ),
      step(
        'Pick the winner and write why people refused',
        'Keep the reasons. They guide the offer more than the price.',
        15,
      ),
    ],
    doneWhen: 'Two prices were offered to 10 buyers each, and the money left for each is in the table.',
    days: 14,
    template: {
      title: 'Price test',
      body: 'Price | Asked | Paid | Left per sale | Money left = paid x left per sale | Reasons for no\n[A] | [ ] | [ ] | [ ] | [ ] | [ ]\n[B] | [ ] | [ ] | [ ] | [ ] | [ ]\nKept: [price], because [ ]',
    },
    traps: ['Asking: what would you pay? Offer a price and see.'],
    referral: null,
    citations: [
      cite('testing-business-ideas', 'Section 3, Experiments: Validation'),
      cite('disciplined-entrepreneurship', 'Step 16 (pricing framework)'),
      cite('mom-test', 'Ch. 5, Commitment and Advancement'),
    ],
    next: ['unit-economics', 'break-even', 'first-ten-customers'],
  },
  {
    id: 'unit-economics',
    title: 'Work out the money in one sale',
    stage: 'business_model',
    intents: ['unit-economics'],
    criteria: ['model-unit-economics'],
    answer:
      'Work it out for one sale, with your own numbers, in this order. Start with the price they pay. Take off everything that sale uses up: materials, fees, delivery and paid time. What remains is the contribution. Multiply it by how many times one customer buys. Take off what it cost you to win that customer. If the result is below zero, do not sell more yet. Change the price, the cost or how often they buy. Tell me your figures and I will do the sums with you.',
    why: 'Selling more of something that loses money only loses it faster. One sale on paper shows which number to fix.',
    steps: [
      step(
        'Write the price actually paid, after discounts and refunds',
        'From your own sales or your price test.',
        10,
      ),
      step(
        'List every cost that happens once per sale',
        'Materials, packaging, payment fee, delivery, paid help. Rent does not go here.',
        20,
      ),
      step(
        'Subtract to get the contribution, then multiply by repeat purchases',
        'Use repeats you have seen. If you have none, use one.',
        10,
      ),
      step(
        'Add up what you spent to win customers and divide by how many you won',
        'Ads, samples, travel and your selling hours.',
        15,
      ),
    ],
    doneWhen:
      'A table with your own price, costs per sale, repeats and cost to win a customer shows what is left.',
    days: 3,
    template: {
      title: 'One-sale table (your numbers only)',
      body: 'Price paid: P = [ ]\nCosts per sale: materials [ ] + fees [ ] + delivery [ ] + paid time [ ] = V = [ ]\nContribution: C = P - V = [ ]\nTimes a customer buys (seen so far): N = [ ]\nValue of a customer: C x N = [ ]\nSpent to win customers [ ] / customers won [ ] = W = [ ]\nLeft per customer: (C x N) - W = [ ]\nSales to earn back W: W / C = [ ]\nEach number is: measured / guess',
    },
    traps: [
      'Leaving out your own time, so a hobby looks like a business.',
      'Guessing repeat purchases before you have seen any.',
    ],
    referral: null,
    citations: [
      cite('disciplined-entrepreneurship', 'Step 17 and Step 19 (lifetime value and acquisition cost)'),
      ain(AIN.mindset2),
      cite('openstax-entrepreneurship', '9.4 Developing Startup Financial Statements and Projections'),
    ],
    next: ['break-even', 'pricing', 'money-to-start'],
  },
  {
    id: 'break-even',
    title: 'Work out how many sales cover your costs',
    stage: 'business_model',
    intents: ['break-even'],
    criteria: ['model-unit-economics'],
    answer:
      'Break-even is the number of sales a month where you stop losing money. Add up the costs you pay every month even with no sales. Divide that by what is left from one sale. The answer is your number. Compare it with how many you could sell in a good week, times four. If break-even is higher, lower the monthly costs first, then raise the price, then look for a customer who buys more at once.',
    why: 'One division tells you whether the plan can work with the customers you can really reach. It also shows which number is the easiest to change.',
    steps: [
      step(
        'List the costs you pay every month, even with no sales',
        'Tools, rent, insurance, phone, subscriptions, pay.',
        20,
      ),
      step(
        'Take what is left from one sale from your one-sale table',
        'Price minus the costs of that sale.',
        5,
      ),
      step(
        'Divide, and compare with what you can really sell in a month',
        'Use your best real week so far, times four.',
        10,
      ),
      step('Change one number and redo it', 'Try lower monthly costs, then price, then a bigger order.', 15),
    ],
    doneWhen: 'A break-even number of sales is written next to the number you can really sell in a month.',
    days: 2,
    template: {
      title: 'Break-even',
      body: 'Monthly costs with no sales: F = [ ] + [ ] + [ ] = [ ]\nLeft from one sale: C = [ ]\nBreak-even sales a month: F / C = [ ]\nI can sell in a month: best week [ ] x 4 = [ ]\nGap: [ ]\nChange I will try: [lower F / raise price / bigger order]\nNew break-even: [ ]',
    },
    traps: ['Using revenue instead of what is left from a sale.'],
    referral: null,
    citations: [
      cite('sba-plan', 'Calculate your startup costs'),
      cite('openstax-entrepreneurship', '9.3 Accounting Basics for Entrepreneurs'),
    ],
    next: ['money-to-start', 'financial-forecast', 'price-test'],
  },
  {
    id: 'money-to-start',
    title: 'Write two lists of the money you need',
    stage: 'business_model',
    intents: ['money-to-start'],
    criteria: ['model-money-needed'],
    answer:
      'Less than you think for the first proof, and I will not guess a number for you. Do it in two lists. List one is what you need to sell to your next ten customers by hand. That is the only money you need now, and it is often what you can earn or borrow from your own pocket. List two is what it takes to run for a year, with one-time and monthly costs. Build list two from quotes, and look for money only when list one has worked.',
    why: 'Founders raise for the big version and spend it before they have proof. Money for the next proof is easier to find and harder to waste.',
    steps: [
      step(
        'Write list one: what the next 10 customers need',
        'Borrow, rent or do by hand before you buy.',
        20,
      ),
      step(
        'Get real quotes for every line above what you would spend without thinking',
        'A web price or an email from a supplier. Save the link.',
        60,
      ),
      step(
        'Write list two: one-time and monthly costs for a year',
        'Cover space, equipment, licenses, insurance, pay and marketing. Leave a line blank rather than guess.',
        45,
      ),
      step(
        'Subtract what you expect from sales, using only prices people have paid',
        'What is left over is the gap to fund.',
        20,
      ),
    ],
    doneWhen: 'You have two lists with a source for each line, and the gap to the next proof is one number.',
    days: 7,
    template: {
      title: 'Money I need',
      body: 'List one, next 10 customers: item | cost | source\n[ ] | [ ] | [quote]\nTotal one: [ ]\nList two, first year: one-time | cost | source, and monthly | cost | source\n[ ] | [ ] | [ ]\nTotal one-time: [ ]  Total monthly x 12: [ ]\nSales I can support with paid prices: [ ]\nGap: list two - sales = [ ]\nHow I fund list one: [own money, earnings, small grant, prize]',
    },
    traps: [
      'One big number with no lines behind it.',
      'Paying for a company, an app and a logo before the first sale.',
    ],
    referral: null,
    citations: [
      cite('sba-plan', 'Calculate your startup costs'),
      ain(AIN.bootstrapping),
      cite('openstax-entrepreneurship', '9.1 Overview of Entrepreneurial Finance and Accounting Strategies'),
    ],
    next: ['bootstrapping', 'break-even', 'grants-angels-vc'],
  },
  {
    id: 'financial-forecast',
    title: 'Make a 12-month cash forecast in three versions',
    stage: 'business_model',
    intents: ['financial-forecast'],
    criteria: ['model-money-needed', 'growth-plan'],
    answer:
      'Forecast twelve months from what you do, not from a growth curve. Each month starts with how many people you can ask, how many of them buy in your own results, and what one sale leaves. Put costs in the month the cash leaves. Make three versions and change only the share that buys. The row that matters is cash at the end of each month. If it goes below zero, you have found the month to fix before you get there.',
    why: 'A forecast is a way to see when you run out of cash and why. Nobody believes the exact numbers, including you.',
    steps: [
      step(
        'Write the 4 numbers that drive it',
        'People asked a month, share that buys, left per sale, monthly costs. From your own results.',
        30,
      ),
      step(
        'Fill 12 months, cash in and cash out',
        'Put money in the month it arrives, not the month you sold.',
        60,
      ),
      step(
        'Make a low and a high version by changing one driver',
        'Change the driver you are least sure of.',
        20,
      ),
      step(
        'Mark the lowest cash month and what you would do about it',
        'Delay a cost, sell earlier or fund it.',
        15,
      ),
    ],
    doneWhen: 'You have a 12-month cash row in three versions, and a plan for the lowest month.',
    days: 7,
    template: {
      title: '12-month cash forecast',
      body: 'Drivers: asked per month [ ]  share that buys [ ] (from [test])  left per sale [ ]  monthly costs [ ]\nMonth | Asked | Sales | Cash in | Cash out | Cash at end\n1 | [ ] | [ ] | [ ] | [ ] | [ ]\n... to 12\nLowest month: [ ] with [ ]. What I do: [ ]',
    },
    traps: [
      'Growing by the same share every month because the chart looks right.',
      'Mixing up sales and cash.',
    ],
    referral: null,
    citations: [
      cite('openstax-entrepreneurship', '9.4 Developing Startup Financial Statements and Projections'),
      cite('sba-plan', 'Write your business plan'),
    ],
    next: ['runway', 'ain-plan-capstone', 'break-even'],
  },
  {
    id: 'bootstrapping',
    title: 'Write your loss limit and ask 3 customers to pay early',
    stage: 'business_model',
    intents: ['bootstrapping'],
    criteria: ['model-money-needed'],
    answer:
      'Bootstrap first. Get customers to fund the start: deposits, prepaid orders, a paid pilot. Put what you earn back in, and swap money for effort wherever you can. Choose outside money only if it lets you capture something that would be gone later, and your one-sale numbers already work. Set a limit on your own money now and write it down. If you reach it without strangers paying, stop and think again.',
    why: 'The programme points out that bootstrapping keeps you in control and forces creative answers. Limits show you what matters.',
    steps: [
      step(
        'Write the most of your own money you can lose',
        'Money for rent, tuition and food is not on the table.',
        10,
      ),
      step(
        'List 3 ways customers could pay earlier',
        'Deposit, prepay for a batch, paid setup, pilot fee.',
        20,
      ),
      step(
        'List what you can borrow, trade or use at the University',
        'Labs, software, rooms, mentors, class projects. Check the rules for commercial use.',
        30,
      ),
      step(
        'Ask 3 customers for one of the early payments',
        'Offer something in return, such as a first place or a fixed price.',
        60,
      ),
    ],
    doneWhen:
      'A loss limit is written, 3 customers were asked to pay early, and the borrowed things are listed.',
    days: 10,
    template: {
      title: 'Bootstrap plan',
      body: 'My limit: [amount I can lose], decided on [date]\nEarly payment I ask for: [deposit / prepay / pilot fee] from [names]\nBorrow or trade: [tool], [space], [skill for skill]\nGoes back in: [share of each sale]\nI stop and think if: [limit reached] or [date] without [number] strangers paying',
    },
    traps: [
      'A credit card as a business plan.',
      'Using a university lab for a company without checking the rules.',
    ],
    referral: null,
    citations: [
      ain(AIN.bootstrapping),
      ain(AIN.mindset2),
      cite('openstax-entrepreneurship', '9.2 Special Funding Strategies'),
    ],
    next: ['pre-sale', 'runway', 'grants-angels-vc'],
  },
  {
    id: 'grants-angels-vc',
    title: 'Choose one money source and list 3 places to apply',
    stage: 'business_model',
    intents: ['grants-angels-vc'],
    criteria: ['model-money-needed'],
    answer:
      'In this order: customers, then grants and competitions, then angels, then venture capital, and stop at the first one that funds your next proof. Grants suit research and early proof, and you keep your shares. Angels suit a venture with first customers that needs to move. Venture capital suits a venture that could become very large and must grow fast to get there. Most student ventures need the first two. Taking money can be a securities matter, so get advice before you offer shares.',
    why: 'Each source wants something different back. The question from the programme is why you are taking the money and whether it helps you capture something in time.',
    steps: [
      step(
        'Write the next proof, its cost and its date',
        'Two lines. If you cannot, you are not ready to raise.',
        15,
      ),
      step('Match the proof to the source in the table', 'Take the first row that fits.', 10),
      step(
        'List 3 real places to apply or ask, with deadlines',
        'Campus competitions, grants your EIR knows, SBIR or STTR for research.',
        45,
      ),
      step(
        'Take the plan to your EIR before you contact any investor',
        'Ask which one would be a waste of your term.',
        45,
      ),
    ],
    doneWhen:
      'The next proof has a cost and a date, one source is chosen, and 3 places with deadlines are listed.',
    days: 10,
    template: {
      title: 'Which money',
      body: 'Next proof: [what], costs [amount], by [date]\nSource | Fits when | Gives up\nCustomers | you can presell | nothing but effort\nGrant or competition | research or early proof | time, reports, rules of use\nFriends and family | small and clear | the relationship if it fails; get advice\nAngel | first customers, clear use of money | shares or a convertible note\nVenture capital | could be very large, must be fast | shares, board seat, speed\nMine: [source]. Three places: [name, deadline] x 3',
    },
    traps: [
      'Pitching investors to find out whether the idea is good. Customers do that.',
      'Writing grants all term instead of selling.',
    ],
    referral: REFERRALS.securities(
      'The next proof and its cost, who you plan to ask, and anything you have already said or offered to them.',
    ),
    citations: [
      ain(AIN.mindset2),
      ain(AIN.fundraising),
      cite('sbir'),
      cite('venture-deals', 'Ch. 2, Preparing for Fundraising'),
    ],
    next: ['bootstrapping', 'investor-meeting', 'pitch-competition'],
  },
  {
    id: 'friends-family-money',
    title: 'Write down each family offer and ask a lawyer first',
    stage: 'business_model',
    intents: ['friends-family-money'],
    criteria: [],
    answer:
      'Do not take it yet. Offering shares, or a promise of a share of profits, can be a securities transaction even with your uncle. The SEC says every offer and sale must be registered or fit an exemption. I am not a lawyer, and this is orientation. Safer first steps are a prepaid order, a gift with no strings, or a small loan on paper that a lawyer has read. Only let people put in what they can lose, and tell them so.',
    why: 'A friendly check with nothing on paper can scare off later investors and cost you the friendship. Clean paper is quick if done first.',
    steps: [
      step(
        'Write what each person offered and what they think they get',
        'Ask them. People often have different deals in mind.',
        20,
      ),
      step(
        'Offer a prepaid order or a later conversation instead',
        'Say: I want to do this properly, so I am getting advice first.',
        20,
      ),
      step(
        'Ask your EIR and a lawyer how to take it',
        'Bring the list. Ask about crowdfunding rules if you plan a campaign.',
        45,
      ),
    ],
    doneWhen:
      'The offers are written down, nobody has paid for shares, and a lawyer or EIR has your question.',
    days: 7,
    template: {
      title: 'What to say',
      body: '"Thank you. I would love to have you with me. I have learned that taking money for part of a company has rules, so I am getting advice first. If you want to help today, you could order one or introduce me to [kind of customer]."\nList for the lawyer: name | amount offered | what they expect | anything already paid or written',
    },
    traps: [
      'Posting on social media that you are looking for investors.',
      'A note on a napkin with a share of the company.',
    ],
    referral: REFERRALS.securities(
      'Who offered what, what they expect in return, anything paid or written, and any public post about raising money.',
    ),
    citations: [
      cite('sec-exempt'),
      cite('sec-safe'),
      ain(AIN.mindset2),
      cite('venture-deals', 'Ch. 10, Crowdfunding'),
    ],
    next: ['grants-angels-vc', 'bootstrapping', 'legal-structure'],
  },
  {
    id: 'valuation',
    title: 'Write the proof page and book a talk about terms',
    stage: 'business_model',
    intents: ['valuation'],
    criteria: [],
    answer:
      'Do not put a number on it yet, and do not let me or any website make one up. With no revenue there is no formula that gives a true value. What a company is worth then is what an investor and a founder agree on in a deal. So before you name a figure, take it to your EIR and a startup lawyer. Meanwhile, work on what moves it: proof that strangers pay, one-sale numbers that work, and a clear use for the money. Many first rounds avoid the question with a note or a similar paper. Ask about that.',
    why: 'A number said too early sticks. A high one can block the next round, and a low one costs you shares. Evidence changes it more than argument does.',
    steps: [
      step(
        'Write what the money is for and what it would prove',
        'An amount without a purpose invites a bad price.',
        20,
      ),
      step(
        'Collect your proof on one page',
        'Paid customers, one-sale table, tests with their lines, team, anything protected.',
        40,
      ),
      step(
        'Read two chapters: the term sheet overview and convertible debt',
        'Write down 5 words you do not understand. Ask about those.',
        90,
      ),
      step(
        'Meet your EIR, then a startup lawyer, before you say a figure',
        'Until then say: we are focused on proof and will discuss terms with advice.',
        60,
      ),
    ],
    doneWhen: 'The proof page is written, and a meeting about terms with your EIR or a lawyer has a date.',
    days: 10,
    template: {
      title: 'Before we talk value',
      body: 'Money is for: [next proof], costs [amount], by [date]\nProof so far: paid customers [ ], left per sale [ ], tests passed [ ], team [ ], protected [ ]\nWho asked for a value, and when: [ ]\nWhat to say: "We are getting advice on terms. Today I can show you what we have proven and what this money would prove."\nQuestions: note or shares? how much of the company is this? what happens in the next round?',
    },
    traps: [
      'Multiplying a share of a giant market by a number from the internet.',
      'Letting a friendly investor write the only draft.',
    ],
    referral: REFERRALS.securities(
      'Your proof page, what the money is for, who asked for a value, and any draft terms or messages about shares.',
    ),
    citations: [
      cite('venture-deals', 'Ch. 5, Economic Terms of the Term Sheet'),
      cite('venture-deals', 'Ch. 8, Convertible Debt'),
      cite('high-growth-handbook', 'Ch. 8, Financing and valuation'),
      cite('sec-exempt'),
    ],
    next: ['term-sheet', 'investor-meeting', 'unit-economics'],
  },
  {
    id: 'term-sheet',
    title: 'Have a lawyer read the term sheet',
    stage: 'business_model',
    intents: ['term-sheet'],
    criteria: [],
    answer:
      'Do not sign it and do not answer on the spot. Thank them, ask for a week, and take it to a startup lawyer and your EIR. I cannot tell you whether to accept, and this is orientation. Read it in three piles: money, control and everything else. Money is what share they get and who is paid first. Control is who can stop you from doing things. Ask for a plain-words summary of each line. A good investor expects you to get advice.',
    why: 'Small words decide who owns and who decides. Terms signed in a first round tend to come back in the next one.',
    steps: [
      step(
        'Reply: thank you, we are reviewing it with counsel and will answer by a date',
        'Check for a no-shop or an expiry date and tell the lawyer first.',
        10,
      ),
      step('Mark each line money, control or other', 'Circle what you do not understand.', 45),
      step('Build a simple table of who owns what before and after', 'A lawyer or EIR can check it.', 45),
      step(
        'Meet the lawyer and write your 3 points to discuss',
        'Not twenty. Three you would walk away for.',
        60,
      ),
    ],
    doneWhen:
      'A lawyer has read the term sheet, the ownership table is checked, and your 3 points are written.',
    days: 7,
    template: {
      title: 'Term sheet notes for the lawyer',
      body: 'From: [investor]  Expires: [date]  No-shop: [yes/no]\nMoney: [line, what I think it means, question]\nControl: [line, what I think it means, question]\nOther: [line, question]\nOwnership: person | before | after\n[ ] | [ ] | [ ]\nMy three points: 1 [ ]  2 [ ]  3 [ ]',
    },
    traps: ['Saying yes by email before advice.', "Using an investor's lawyer as your own."],
    referral: REFERRALS.securities(
      'The full document, any side messages, the expiry date, who owns what today and your three points.',
    ),
    citations: [
      cite('venture-deals', 'Ch. 4, Overview of the Term Sheet'),
      cite('venture-deals', 'Ch. 6, Control Terms of the Term Sheet'),
      cite('art-of-strategy', 'Bargaining'),
    ],
    next: ['valuation', 'investor-meeting', 'legal-structure'],
  },
  {
    id: 'equity-split',
    title: 'Fill in one contribution sheet each and compare them',
    stage: 'business_model',
    intents: ['equity-split'],
    criteria: [],
    answer:
      'Do not shake hands on half and half today. Use three rules, then have a lawyer put them on paper. Split by what each of you will do and risk from now on, not only by who had the idea. Make every share earned over time, which is called vesting, so someone who leaves early does not keep a full share. And agree now what changes the split: hours, money put in, or someone leaving for a job. Talk it through this week. Sign nothing until a lawyer has read it. I am not one.',
    why: 'Founders who split quickly to avoid the talk often have it later, with more at stake. Rules made early are easier to accept.',
    steps: [
      step(
        'Each of you fills the contribution sheet alone',
        'Idea, skills, hours from now, money, network, risk and what you give up.',
        30,
      ),
      step(
        'Compare for an hour and talk about the gaps',
        'Ask what would feel unfair in a year. Write the answers.',
        60,
      ),
      step(
        'Write the rules: split, vesting, what changes it, who decides if tied',
        'As a list of points for the lawyer, not as a contract.',
        40,
      ),
      step(
        'Take it to your EIR and a lawyer before anyone signs',
        'Ask about tax papers with short deadlines when shares are issued.',
        45,
      ),
    ],
    doneWhen:
      'Both sheets are compared, the points are in one list, and a lawyer has the list before signing.',
    days: 14,
    template: {
      title: 'Contribution sheet, one per person',
      body: 'Name: [ ]\nHours a week from now, for how long: [ ]\nSkills that nobody else has: [ ]\nMoney in: [ ]\nNetwork or customers I bring: [ ]\nWhat I give up: [ ]\nWhat I want in three years: [ ]\nPoints for the lawyer: split [ ], earned over [ ], if one leaves [ ], if hours change [ ], if money goes in [ ], ties are decided by [ ], roles [ ]',
    },
    traps: ['Equal shares because it is awkward to talk.', 'Promising shares to helpers in messages.'],
    referral: REFERRALS.lawyer(
      'Both contribution sheets, the points you agree on, the points you do not, and anything already promised in writing.',
    ),
    citations: [
      cite('founders-dilemmas', 'Reward Dilemmas: Equity Splits and Cash Compensation'),
      cite('openstax-entrepreneurship', '12.2 Building the Entrepreneurial Dream Team'),
    ],
    next: ['cofounder-agreement', 'legal-structure', 'find-cofounder'],
  },
  {
    id: 'cofounder-agreement',
    title: 'Write who decides what on one page for a lawyer',
    stage: 'business_model',
    intents: ['cofounder-agreement'],
    criteria: [],
    answer:
      'Write one page on roles this week, and let a lawyer turn the rest into an agreement. The page says who owns which decision, the hours each gives, what happens in exams and at graduation, and how you break a tie. One name per decision. The agreement then covers shares earned over time, who owns the work you make, confidentiality and what happens if someone leaves. I am not a lawyer, so do not copy one from the internet and sign it.',
    why: 'Titles do not settle who decides. A list of decisions with one name each prevents most of the daily friction.',
    steps: [
      step(
        'List the 10 decisions you make in a month',
        'Price, hiring, product, spending, customers, pitch.',
        20,
      ),
      step('Put one name next to each, and a spending limit', 'Both names means nobody decides.', 20),
      step(
        'Agree hours, exam weeks, summer, graduation and tie-break',
        'Write what happens if someone takes a job.',
        45,
      ),
      step(
        'Send the page to a lawyer for the agreement',
        'Ask what must be signed before anyone creates code, designs or inventions.',
        30,
      ),
    ],
    doneWhen: 'The one-page roles list is agreed by all founders, and a lawyer has it.',
    days: 10,
    template: {
      title: 'Roles page',
      body: 'Decision | Owner | Asks first | Spending limit\n[price] | [ ] | [ ] | [ ]\n[product] | [ ] | [ ] | [ ]\n[customers] | [ ] | [ ] | [ ]\nHours a week: [name] [ ], [name] [ ]\nExam weeks: [ ]  Summer: [ ]  Graduation: [ ]\nIf someone takes a job: [ ]\nTie: [who decides, or which adviser we ask]\nFor the lawyer: shares earned over time, work we make, confidentiality, leaving',
    },
    traps: ['Two chief executives.'],
    referral: REFERRALS.lawyer(
      'The roles page, who has made what so far, any University work in it, and what each of you expects if someone leaves.',
    ),
    citations: [
      cite('founders-dilemmas', 'Role Dilemmas'),
      ain(AIN.legalStructure),
      cite('openstax-entrepreneurship', '13.1 Business Structures: Overview of Legal and Tax Considerations'),
    ],
    next: ['equity-split', 'team-conflict', 'legal-structure'],
  },
  {
    id: 'cofounder-left',
    title: 'Secure the code and the accounts after a cofounder leaves',
    stage: 'business_model',
    intents: ['cofounder-left'],
    criteria: [],
    answer:
      'Secure three things today, before you plan anything else: the code, the accounts and the customers. List what exists and who can get into it. Ask your cofounder in writing for access and a copy of everything. Do not assume the work is yours, because the person who made it may own it. A lawyer tells you who does, and I am not one. Then write to your customers that you are still here.',
    why: 'People hand things over most easily in the first days. Later it gets slower and costs more.',
    steps: [
      step(
        'List the code, accounts, data and money, and who can get into each',
        'Where the code is, the domain, the app store, payments, email and the bank.',
        30,
      ),
      step(
        'Ask for access and a copy of everything in one friendly message',
        'Short and in writing. No blame, and a date to answer by.',
        15,
      ),
      step(
        'Take the list to a lawyer and ask who owns what',
        'Bring anything you both signed or wrote, and who paid for what.',
        45,
      ),
      step('Tell your customers who to write to now', 'Two lines: what still works, and your name.', 20),
    ],
    doneWhen:
      'Every account on the list has a name beside it, you asked for access in writing, and a lawyer has the list.',
    days: 3,
    template: {
      title: 'Handover message',
      body: 'Hi [name], thank you for what you built. I need to keep [venture] running for our customers. Could you give me access to [accounts] and a copy of [code, designs, data] by [date]? I would like us to write down what each of us keeps.',
    },
    traps: ['Locking them out before you asked. It turns a handover into a fight.'],
    referral: REFERRALS.lawyer(
      'The list of code, accounts and data, who made what, anything you both signed or wrote, and any shares you promised.',
    ),
    citations: [
      cite('founders-dilemmas', 'Role Dilemmas'),
      ain(AIN.legalStructure),
      cite('openstax-entrepreneurship', '13.1 Business Structures: Overview of Legal and Tax Considerations'),
    ],
    next: ['cofounder-agreement', 'no-tech-skills', 'find-cofounder'],
  },
  {
    id: 'legal-structure',
    title: 'Write 3 questions on legal structure and book a meeting',
    stage: 'business_model',
    intents: ['legal-structure'],
    criteria: [],
    answer:
      'Not before you need one, and not without a lawyer and an accountant. You need one when you take real money, sign a contract, hire, or could hurt someone. In plain words: working as yourself, with or without a business name, is the simplest, and it leaves you personally liable. A limited liability company separates you from its debts and is flexible on tax. A corporation also separates you and pays its own tax. Which one fits is their call. I can help you arrive with the right questions.',
    why: 'The programme strongly recommends a lawyer and an accountant here. Protection, tax and plans to raise money all pull on the choice.',
    steps: [
      step(
        'Check if you need one now',
        'Money from customers, a contract, staff, a risk of harm, or an investor. None of these yet means wait.',
        10,
      ),
      step(
        'Read the SBA page on structures and write 3 questions',
        'Liability, tax, owners. Use its comparison table.',
        40,
      ),
      step(
        'Write your plans for two years in five lines',
        'Owners, investors, hires, states you sell in, visa status of each founder.',
        20,
      ),
      step(
        'Book a lawyer and an accountant through the program lead',
        'Bring the five lines and the questions.',
        20,
      ),
    ],
    doneWhen:
      'You know if you need one now, and the five lines and 3 questions are ready for a booked meeting.',
    days: 10,
    template: {
      title: 'For the lawyer and the accountant',
      body: 'Do we need it now? money [ ], contract [ ], staff [ ], harm [ ], investor [ ]\nOwners and their visa status: [ ]\nInvestors in two years: [yes/no/maybe]\nHires: [ ]  Where we sell: [ ]\nName we use: [ ]\nQuestions: 1 [liability]  2 [tax]  3 [what to file, what it costs each year]',
    },
    traps: [
      'Filing online in another state because a video said so.',
      'Selling something that can hurt people with no protection at all.',
    ],
    referral: REFERRALS.accountant(
      'Your five-line plan, who the owners are, what you sell, whether you want investors, and your three questions.',
    ),
    citations: [
      ain(AIN.legalStructure),
      cite('sba-launch', 'Choose a business structure'),
      cite('irs-structures'),
    ],
    next: ['taxes', 'cofounder-agreement', 'contracts-and-insurance'],
  },
  {
    id: 'contracts-and-insurance',
    title: 'Write the deal on one page and have a lawyer read it',
    stage: 'business_model',
    intents: ['contracts-and-insurance'],
    criteria: [],
    answer:
      'Do not sign or send a contract that a lawyer has not read, and do not sell something that could hurt someone without asking about insurance. I am not a lawyer, and this is orientation. What you can do now is write the deal in plain words: who does what, when, for how much, what can go wrong and who pays for it. That page saves time and money when the lawyer drafts. Until then, keep first sales small and low in risk.',
    why: 'A contract decides what happens on the bad day. A business owner can be personally responsible, and the University does not carry that risk for you.',
    steps: [
      step(
        'Write the deal on one page in plain words',
        'Parties, work, dates, price, what can go wrong, how it ends.',
        40,
      ),
      step(
        'List the 3 worst things that could happen',
        'Injury, lost data, broken property, late delivery.',
        15,
      ),
      step(
        'Ask a lawyer about the page and the list',
        'Through the program lead. Ask what must be in writing and what you should not promise.',
        45,
      ),
      step(
        'Ask an insurance agent for quotes on those risks',
        'General liability and product liability are the words to use.',
        30,
      ),
    ],
    doneWhen:
      'The one-page deal and the list of risks have been read by a lawyer, and one insurance quote is asked for.',
    days: 14,
    template: {
      title: 'Deal in plain words, for the lawyer',
      body: 'Between: [ ] and [ ]\nWe do: [ ] by [date]. They do: [ ] by [date]\nPrice and when paid: [ ]\nWe do not promise: [ ]\nWho owns what is made: [ ]\nData we touch: [ ]\nThree worst things: [ ], [ ], [ ]\nEither side can stop by: [ ]\nThey asked us to sign: [attach]',
    },
    traps: [
      'A template from the internet with your name in it.',
      'Agreeing in a message to something you would not sign.',
    ],
    referral: REFERRALS.lawyer(
      'The one-page deal, the three worst things that could happen, and any paper the other side wants you to sign.',
    ),
    citations: [
      cite('sba-launch', 'Get business insurance'),
      cite('openstax-entrepreneurship', '13.7 Mitigating and Managing Risks'),
      cite('sba-manage', 'Stay legally compliant'),
    ],
    next: ['legal-structure', 'pilot-agreement', 'permits-food'],
  },
  {
    id: 'taxes',
    title: 'Open a separate account and start a tax sheet',
    stage: 'business_model',
    intents: ['taxes'],
    criteria: [],
    answer:
      'Keep every receipt from today, use a separate account, and ask an accountant what you must file. I cannot give tax advice. In general, money you earn from selling counts as income even without a company, and the IRS has a page for people who work for themselves. Sales tax is a separate question, and it depends on what you sell and where. Write down every sale and cost in one sheet now. That sheet is what the accountant needs, and it doubles as your one-sale table.',
    why: 'The work is easy when records exist and painful when they do not. The rules depend on you, your state, your visa and your structure.',
    steps: [
      step(
        'Open a separate account for the venture',
        'A second account at your bank is enough to start. Ask them what they need.',
        40,
      ),
      step(
        'Start one sheet: date, who, what, in, out, receipt',
        'Fill it every Sunday. Photograph paper receipts.',
        20,
      ),
      step(
        'Read the IRS page for self-employed people and write 3 questions',
        'Income tax, self-employment tax, and dates.',
        30,
      ),
      step(
        'Meet an accountant and ask about sales tax as well',
        'If you are on a visa, see the International Services Office first.',
        45,
      ),
    ],
    doneWhen: 'You have a separate account and a sheet, and an accountant has the sheet and 3 questions.',
    days: 14,
    template: {
      title: 'Records and questions',
      body: 'Sheet columns: date | from or to | what for | money in | money out | receipt photo\nWhat I sell: [ ]  Where: [ ]  To: [people / companies]\nSince: [date]  Total in: [ ]  Total out: [ ]\nMy status: [citizen / visa type]  Structure: [none / DBA / LLC / corporation]\nQuestions: 1 What must I file? 2 Do I collect sales tax? 3 What should I set aside, and when is it due?',
    },
    traps: ['Mixing personal and venture money in one account.'],
    referral: REFERRALS.accountant(
      'Your records sheet, what you sell and where, your structure or none, your visa status, and three questions.',
    ),
    citations: [cite('irs-self-employed'), cite('irs-structures'), cite('sba-manage', 'Pay taxes')],
    next: ['legal-structure', 'runway', 'international-student'],
  },
  {
    id: 'international-student',
    title: 'Send the International Services Office your list of questions',
    stage: 'idea',
    intents: ['international-student', 'visa-said'],
    criteria: [],
    answer:
      'Talk to the International Services Office before you do any work or take any money, even for your own idea. I cannot advise on this, and it is orientation only. The government page says that starting a business counts as work. An F-1 student must first qualify and apply for practical training, and the business must relate to your field of study. Ask the office what you may do today. It might be learning, interviews or a class project. Do only that until they answer in writing.',
    why: 'Unauthorized work can end your status, and it cannot be fixed afterwards. The office answers this often and knows your record.',
    steps: [
      step(
        'Write what you have done so far, and what you plan to do next month',
        'Interviews, selling, coding, being paid, owning shares, being on a team.',
        25,
      ),
      step(
        'Pause anything paid, sold or signed',
        'Tell your team why. Keep to research until you have an answer.',
        10,
      ),
      step(
        'Email the International Services Office with the list',
        'Ask which items are fine now, which need permission, and how long it takes.',
        15,
      ),
      step(
        'Ask before shares or a title are put in your name',
        'An immigration lawyer may be needed. The office can say.',
        10,
      ),
    ],
    doneWhen:
      'The list has been sent to the International Services Office, and you are doing only what they confirmed.',
    days: 3,
    template: {
      title: 'Email to the International Services Office',
      body: 'Subject: F-1 question before I do anything on a venture\nHello,\nI am a [year] student in [program] on [visa], finishing on [date]. I have an idea for a venture in [general area]. So far I have: [list]. Next month I would like to: [list].\nWhich of these may I do now, which need authorization first, and how long does it take? May I own shares or hold a title?\nI have not been paid.\nThank you, [name, ID]',
    },
    traps: ['Believing unpaid means it is not work.', 'Taking advice from a friend with a different visa.'],
    referral: REFERRALS.international(
      'Your visa, program and end date, the list of what you did and plan to do, and any money, shares or title offered.',
    ),
    citations: [cite('dhs-entrepreneurship'), cite('uscis-opt'), cite('ur-iso')],
    next: ['legal-structure', 'taxes', 'find-ten-people'],
  },
  {
    id: 'permits-food',
    title: 'Ask the county and the University about permits',
    stage: 'business_model',
    intents: ['permits-food'],
    criteria: [],
    answer:
      'Ask before you sell, and start by reselling food made in a kitchen that already has a permit. I cannot tell you what you need, and this is orientation. Selling food to the public falls under state and county health rules. The campus has rules on selling as well. In Monroe County, a short food event needs its own permit. So make your first test a set of orders that a licensed restaurant fills. Ask the restaurant and the University first.',
    why: 'Food can make people ill, and a closed stand ends the test. A licensed partner lets you test demand while the permit question is answered.',
    steps: [
      step(
        'Write what you sell, where it is made, who serves it and where',
        'Home kitchen, restaurant, dorm, quad, online.',
        15,
      ),
      step(
        'Call the county health department and ask which permit fits',
        'Read them your four lines. Write the name and the date of the call.',
        30,
      ),
      step(
        'Ask the University who approves selling on campus',
        'Start with the program lead or the student activities office.',
        20,
      ),
      step(
        'Ask one licensed place to fill 10 orders for you',
        'Agree the price per piece, the time and who answers for the food.',
        45,
      ),
    ],
    doneWhen:
      'The county and the University have answered in writing, and one licensed place has said yes or no.',
    days: 14,
    template: {
      title: 'Permit call sheet',
      body: 'We sell: [food], made at [place], served by [who], at [where], on [days]\nCounty health: spoke to [name] on [date]. Permit: [ ]. Cost and time: [ask]\nCampus: spoke to [name] on [date]. Allowed: [yes/no/conditions]\nLicensed partner: [place]. Will fill [number] orders at [price per piece]: [yes/no]\nInsurance: asked [ ]',
    },
    traps: ['Cooking in a dorm for the public.', 'Selling alcohol or anything with an age limit. Do not.'],
    referral: {
      category: 'legal',
      role: 'specialist',
      who: 'Monroe County Public Health (food protection) and the University office that approves campus sales',
      bring:
        'What you sell, where it is made, who serves it, where and when, and the licensed partner if you have one.',
    },
    citations: [cite('monroe-food'), cite('fda-food'), cite('sba-launch', 'Apply for licenses and permits')],
    next: ['contracts-and-insurance', 'real-business', 'pre-sale'],
  },
];
