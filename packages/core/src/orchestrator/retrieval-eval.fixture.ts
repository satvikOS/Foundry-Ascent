/**
 * The labelled queries of the local retrieval evaluation (`retrieval-eval.db.test.ts`): how students write, what in the
 * shared knowledge answers it, and messages nothing in it answers. Written for this test (no transcript, no founder's
 * words). Even entries were looked at while the floors were tuned, odd ones only measured.
 *
 * `answers`: parts of the titles (`<source> — <passage>`) that answer the query; a returned passage is relevant when its
 * title contains one. `[]`: nothing answers it, and nothing may be returned.
 */
export interface EvalQuery {
  readonly query: string;
  readonly answers: readonly string[];
}

const LEGAL = [
  'Key term: legal structure',
  'Choose a business structure',
  'Business structures (Internal',
  'Register your business',
];
const USER = [
  'Key term: customer vs. user',
  'The enthusiastic user is rarely the buyer',
  'found its real buyer',
  'Customer segments',
  'Module 1 (mindset',
];
const MODEL = [
  'Key term: business model',
  'Part II (business model)',
  'Key term: Business Model Canvas',
  'Business Model',
  'business plan',
  'Business Plan',
  'Business-model risk tests',
  'Find the one',
];
const CANVAS = [
  'Key term: Business Model Canvas',
  'Business Model Canvas',
  'Lean Canvas',
  'lean startup plan',
  'the canvas',
  'Questions for each part',
];
const DISCOVERY = [
  'Key term: customer discovery',
  'Problem interview guide',
  'last-time interview',
  'customer interviews',
  'run a survey',
  'Interview excerpt',
  'commitment ladder',
  'NSF I-Corps',
  'Customer Discovery',
  'Customer Development',
  'politeness with demand',
  'Get out of the office',
  'Talking to people is a skill',
  'Networking II',
  'Evidence ledger',
  'Experiment card',
  'Free pilots',
  'enthusiastic user',
  'First-',
  'Stage gates',
  'Direct research',
  'Existing data or direct',
  'Why founders have to network',
  'Seasonal spikes',
  'Business-model risk tests',
];
const MVP = [
  'Key term: customer discovery',
  'minimum viable product',
  'Lean Startup',
  'Lean start-up',
  'MVP',
  'Experiment card',
  'Six stages',
  'Use the canvas',
];
const PITCH = ['Key term: the pitch', 'A five-part pitch', 'Pitching at a demo day', 'Pitch', 'pitch'];
const FUND = [
  '(funding)',
  'Key term: fundraising',
  'Key term: bootstrapping',
  'Fund your business',
  'Early-stage investors',
  'Exempt offerings',
  'Common startup securities',
  'Sources of starting capital',
  'Debt or equity',
  'Regulation Crowdfunding',
  'Accredited investors',
];
const BOOT = [
  'Key term: bootstrapping',
  '(funding)',
  'Self-funding',
  'Bootstrap before',
  'Sources of starting capital',
  'Fund your business',
  'Key term: fundraising',
];
const SEC = [
  'Exempt offerings',
  'General solicitation',
  'Regulation Crowdfunding',
  'Consequences of noncompliance',
  'Accredited investors',
  'Get advice before asking',
  'Early-stage investors',
  'Common startup securities',
  '(funding)',
  'Fund your business',
];
const NET = ['Networking I', 'Networking II', 'Alumni'];
const IDEASHARE = [
  'steal my idea',
  'Networking I',
  'Provisional application',
  'Patent essentials',
  'Trademark, patent',
];
const PATENT = [
  'Provisional application for patent',
  'Patent essentials',
  'Trademark, patent or copyright',
  'Commercialization pathways',
  'steal my idea',
];
const TM = ['What is a trademark', 'Trademark, patent or copyright', 'Register your business'];
const EIN = ['employer identification number', 'Federal and state tax IDs', 'Register your business'];
const TAX = [
  'Self-employed individuals',
  'Business structures (Internal',
  'Compare liability and tax',
  'Choose a business structure',
  'Register your business',
];
const PLAN = [
  'Write your business plan',
  'Business Plan Development Guide',
  'The plan is for you',
  'Module 3',
];
const COSTS = [
  'Calculate your startup costs',
  'Business Plan Development Guide',
  'Business-model risk tests',
  'Fund your business',
];
const MARKET = [
  'Market research and competitive',
  'Business Plan Development Guide',
  'Market Sizing',
  'TAM',
  'Beachhead',
  'market size',
  'Write your business plan',
  'Questions market',
];
const COMP = [
  'Market research and competitive',
  'Show your position among',
  'Where your first customers',
  'Five Forces',
  'SWOT',
  'Business-model risk tests',
  'Business Plan Development Guide',
  'Write your business plan',
];
const TEAM = ['(team and job security)', 'Networking I', 'Find co-founders', 'Team'];
const MINDSET = ['Entrepreneurial Mindset', 'Entrepreneurship and Innovation Toolkit'];
const IDEA = [
  'Entrepreneurship and Innovation Toolkit',
  'Entrepreneurial Mindset, Part I',
  'Seven places',
  'Get feedback instead',
  'Design Thinking',
  'Research at four levels',
];
const REG = [
  'Register your business',
  'Choose a business structure',
  'Key term: legal structure',
  'Get an employer',
];
const PRICE = [
  'Pricing a first pilot',
  'Free pilots teach',
  'Business-model risk tests',
  'Sales forecasts',
  'willingness',
  'Break-even',
  'commitment ladder',
  'Unit Economics',
  'Unit economics',
];
const SURVEY = ['run a survey', 'Existing data or direct', 'Market research', ...DISCOVERY];
const NSF = ['NSF I-Corps'];
const GRANTS = [
  'SBIR and STTR',
  'Fund your business',
  'Sources of starting capital',
  'NSF I-Corps',
  'Business Plan Development Guide',
];

export const RETRIEVAL_EVAL: readonly EvalQuery[] = [
  // Customer and user
  {
    query: 'My app is used by students but the university would pay for it. Who is my customer?',
    answers: USER,
  },
  { query: "what's the difference between a customer and a user", answers: USER },
  { query: 'Kids would use our toy but parents buy it, who do we market to?', answers: USER },
  {
    query: 'nurses use our device but the hospital buys it. which one should i talk to first?',
    answers: [...USER, ...DISCOVERY],
  },
  {
    query: 'if my users get it for free and advertisers pay, who is the customer?',
    answers: [...USER, ...MODEL],
  },
  { query: 'can my user and my customer be different people?', answers: USER },
  // Business model
  { query: 'How do I explain how my company makes money?', answers: MODEL },
  { query: 'what is a business model', answers: MODEL },
  { query: 'how should we monetize a free app for college kids', answers: MODEL },
  { query: "I don't get the north star metric thing, what should ours be?", answers: [...MODEL, ...PITCH] },
  {
    query: 'should we charge users or sell their data to companies? which business model is better',
    answers: MODEL,
  },
  { query: 'b2b or b2c for a lab inventory tool?', answers: MODEL },
  { query: 'What makes a business model sustainable for us and for customers?', answers: MODEL },
  {
    query: 'I need help figuring out our revenue streams',
    answers: [...MODEL, 'Cost structure and revenue'],
  },
  // Canvas
  { query: 'How do I fill in a business model canvas?', answers: [...CANVAS, ...MODEL] },
  { query: "what goes in the BMC, I've never done one", answers: [...CANVAS, ...MODEL] },
  {
    query: 'Is the canvas better than a business plan for an idea stage startup?',
    answers: [...CANVAS, ...PLAN, ...MODEL],
  },
  { query: 'how often should i update my canvas', answers: [...CANVAS, ...MODEL] },
  { query: 'do i need a canvas if i already have a pitch deck?', answers: [...CANVAS, ...PITCH, ...MODEL] },
  // Legal structure
  { query: 'Should I form an LLC or a corporation?', answers: LEGAL },
  { query: 'do i need an llc before i sell my first candle', answers: [...LEGAL, ...REG] },
  { query: "what's a DBA and do I need one", answers: LEGAL },
  { query: 'Can I get sued personally if my startup messes up?', answers: LEGAL },
  { query: 'S corp vs C corp for a student startup?', answers: LEGAL },
  { query: 'I am an international student, can I own an S corporation?', answers: LEGAL },
  { query: 'what is a sole proprietorship and am i one already', answers: LEGAL },
  { query: 'How do partnerships work legally? my friend and I each own half', answers: LEGAL },
  { query: 'which legal structure is best if we plan to raise money later?', answers: [...LEGAL, ...FUND] },
  { query: 'can my club project become a nonprofit corporation', answers: LEGAL },
  { query: 'what are the pros and cons of incorporating now?', answers: LEGAL },
  { query: 'how do i register my business with the state', answers: REG },
  { query: 'do we need a business license to sell food on campus?', answers: REG },
  { query: 'when should I open a business bank account', answers: REG },
  { query: 'How do I pick and protect a business name?', answers: [...TM, ...REG] },
  // EIN and taxes
  { query: 'how do I get an EIN and how much is it', answers: EIN },
  { query: 'Do I need an EIN if I have no employees?', answers: EIN },
  { query: 'a website wants $79 to get my EIN, is that legit?', answers: EIN },
  { query: 'do i have to pay taxes on the $600 my side business made', answers: TAX },
  { query: 'What tax forms does a sole proprietor file?', answers: TAX },
  { query: 'I need to understand quarterly taxes for self-employed people', answers: TAX },
  // IP
  { query: 'Can I patent my idea for an app?', answers: PATENT },
  { query: 'what is a provisional patent and how long does it last', answers: PATENT },
  { query: 'I want to show my prototype at a fair, will that ruin my chance of a patent?', answers: PATENT },
  { query: 'how much time do i have to file a patent after presenting it publicly?', answers: PATENT },
  { query: "what's the difference between a trademark and a patent?", answers: [...PATENT, ...TM] },
  { query: 'Should I trademark our logo?', answers: TM },
  { query: 'can I write TM next to our name without registering it?', answers: TM },
  {
    query: 'How do I protect our software code? copyright?',
    answers: ['Trademark, patent or copyright', 'What is a trademark', ...PATENT],
  },
  { query: 'utility patent vs design patent', answers: PATENT },
  { query: 'Should I make people sign an NDA before I tell them my idea?', answers: IDEASHARE },
  { query: "I'm scared someone will steal my idea if I talk about it", answers: IDEASHARE },
  { query: 'is it ok to share my idea with professors or will they copy it', answers: IDEASHARE },
  // Customer discovery
  { query: 'How do I do customer discovery if I have never talked to a customer?', answers: DISCOVERY },
  { query: 'what questions should i ask in a customer interview', answers: DISCOVERY },
  { query: 'How many customer interviews are enough?', answers: DISCOVERY },
  {
    query: 'everyone says they love my idea, how do i know they would actually pay for it?',
    answers: [...DISCOVERY, ...MVP, ...PRICE],
  },
  { query: 'should we run a survey or do interviews first?', answers: SURVEY },
  { query: 'I want to validate demand for my tutoring app before building', answers: [...DISCOVERY, ...MVP] },
  { query: 'how do I find out who my real customer is?', answers: [...DISCOVERY, ...USER] },
  { query: 'is it better to interview people on video or in person', answers: DISCOVERY },
  { query: 'people in interviews are just being nice to me, what do I do?', answers: DISCOVERY },
  { query: 'what is the I-Corps program and how many interviews do they require?', answers: NSF },
  { query: 'can a grad student join i-corps?', answers: NSF },
  {
    query: 'Do I have to talk to customers before I build anything? I am an engineer and I hate that part',
    answers: [...DISCOVERY, ...MVP, ...MINDSET],
  },
  // MVP
  { query: 'what is an MVP and what should mine be?', answers: MVP },
  { query: 'Should I build the app first or test with a prototype?', answers: [...MVP, ...DISCOVERY] },
  { query: 'when should we pivot?', answers: [...MVP, 'Pivot', ...DISCOVERY] },
  { query: 'explain lean startup to me like I know nothing', answers: [...MVP, ...CANVAS] },
  // Pitch
  { query: 'How do I structure my pitch deck?', answers: PITCH },
  { query: 'how many slides should a pitch have', answers: PITCH },
  { query: 'I have a pitch competition in two weeks, what must my pitch include?', answers: PITCH },
  { query: 'what should I say in an elevator pitch to an investor?', answers: PITCH },
  {
    query: 'Do investors still read long business plans or just decks?',
    answers: [...PITCH, ...PLAN, ...FUND],
  },
  { query: 'what metric should i highlight in my pitch', answers: [...PITCH, ...MODEL] },
  { query: 'is it legal to say we are raising money during a demo day?', answers: [...SEC, ...PITCH] },
  // Fundraising and bootstrapping
  { query: 'Should I raise money or bootstrap?', answers: [...FUND, ...BOOT] },
  { query: 'how do i bootstrap with no savings', answers: BOOT },
  { query: 'what do angel investors usually want in return?', answers: FUND },
  { query: 'How does venture capital actually work?', answers: FUND },
  { query: 'what is a convertible note', answers: FUND },
  { query: 'SAFE vs convertible note, which one is simpler?', answers: FUND },
  { query: 'when does it make sense to take outside money?', answers: [...FUND, ...BOOT] },
  { query: "what's the difference between seed and series A", answers: FUND },
  { query: 'how much can i raise from friends and family', answers: [...FUND, ...SEC] },
  {
    query: 'my uncle wants to give me 5k for 10% of the company, is that allowed?',
    answers: [...FUND, ...SEC],
  },
  { query: 'Is it worth giving up equity to grow faster?', answers: [...FUND, ...BOOT] },
  {
    query: 'can I do a kickstarter instead of investors?',
    answers: ['Rewards crowdfunding', 'Regulation Crowdfunding', ...FUND],
  },
  {
    query: 'Can I sell shares online through crowdfunding?',
    answers: [...SEC, 'Rewards crowdfunding', ...FUND],
  },
  { query: 'who counts as an accredited investor?', answers: SEC },
  { query: 'am I allowed to post on linkedin that we are raising a round?', answers: SEC },
  { query: 'what happens if we break securities rules by accident', answers: SEC },
  { query: 'what is rule 506(b)', answers: SEC },
  {
    query: 'how do I get a small business loan as a student?',
    answers: ['loan', 'Fund your business', 'Debt or equity', 'Business Plan Development Guide'],
  },
  { query: 'is debt better than equity for us', answers: ['Debt or equity', ...FUND] },
  { query: 'are there grants for research startups?', answers: GRANTS },
  { query: 'what is SBIR funding', answers: GRANTS },
  // Networking and outreach
  { query: "I'm an introvert and networking terrifies me, any tips?", answers: NET },
  { query: 'how do I write a cold email to a potential customer?', answers: NET },
  { query: 'What should I put in a LinkedIn connection request?', answers: NET },
  { query: 'how do I find a technical co-founder', answers: [...NET, ...TEAM] },
  { query: 'what do i do at a networking event if i know nobody', answers: NET },
  { query: 'How soon should I follow up after meeting someone?', answers: NET },
  { query: 'nobody answers my cold emails, what am I doing wrong?', answers: NET },
  { query: 'how do you break the ice on a zoom call with a stranger', answers: NET },
  // Team and mindset
  { query: 'How do I build a good founding team?', answers: TEAM },
  { query: 'should my teammates think like me?', answers: TEAM },
  { query: 'is it too risky to start a company instead of taking a job?', answers: TEAM },
  { query: 'what is an entrepreneurial mindset?', answers: [...MINDSET, ...TEAM] },
  { query: 'am I cut out to be a founder', answers: MINDSET },
  { query: 'How do I get comfortable with uncertainty when starting something?', answers: MINDSET },
  { query: 'How do I come up with a good startup idea?', answers: IDEA },
  { query: 'is my idea any good?', answers: IDEA },
  { query: 'what is design thinking', answers: [...IDEA, 'Design'] },
  // Business plan, costs, market
  { query: 'How do I write a business plan for the capstone?', answers: PLAN },
  { query: 'what sections go in a traditional business plan', answers: PLAN },
  { query: 'do i need an executive summary and what goes in it?', answers: PLAN },
  { query: 'can you explain financial projections to someone with zero finance background', answers: PLAN },
  { query: 'How do I estimate my startup costs?', answers: COSTS },
  { query: 'how much money do I need to launch a coffee cart', answers: COSTS },
  { query: 'how do I calculate break even', answers: COSTS },
  { query: 'what counts as a fixed cost vs variable cost?', answers: COSTS },
  { query: 'How do I do market research for free?', answers: MARKET },
  { query: 'how big is my market? how do I find data', answers: MARKET },
  { query: 'Who are my competitors if nobody does exactly this?', answers: COMP },
  { query: 'how do i do a competitive analysis', answers: COMP },
  {
    query: 'How do I define my target market?',
    answers: [
      ...MARKET,
      'Define a target market',
      'Value proposition and customer segments',
      'Customer segments',
    ],
  },
  { query: 'how should I price my first pilot?', answers: PRICE },
  { query: 'what do I charge for a monthly subscription, I have no idea', answers: [...PRICE, ...MODEL] },
  { query: 'what is the Module 2 capstone?', answers: ['Ain Foundry curriculum'] },
  { query: 'What does module 3 cover?', answers: ['Ain Foundry curriculum'] },

  // Nothing in the shared knowledge answers these.
  { query: 'What is the weather in Rochester tomorrow?', answers: [] },
  { query: 'How do I cook pasta for my roommates?', answers: [] },
  { query: 'can you write my essay on Hamlet', answers: [] },
  { query: 'What was the score of the Bills game?', answers: [] },
  { query: 'my python script throws an index error, can you fix it?', answers: [] },
  { query: 'translate good morning to Spanish please', answers: [] },
  { query: 'tell me a joke', answers: [] },
  { query: 'solve the integral of x squared', answers: [] },
  { query: 'when is spring break this year?', answers: [] },
  { query: 'recommend a laptop for gaming', answers: [] },
  { query: 'what is the capital of Mongolia', answers: [] },
  { query: 'help me with my physics lab about pendulums', answers: [] },
  { query: 'how do I train for a marathon?', answers: [] },
  { query: 'where is the best pizza near campus', answers: [] },
  { query: 'Explain quantum entanglement', answers: [] },
  { query: 'my roommate keeps stealing my food', answers: [] },
  { query: 'how do I drop a class after the deadline?', answers: [] },
  { query: 'how do I register for classes next semester?', answers: [] },
  { query: 'Should I buy bitcoin?', answers: [] },
  { query: 'what should I wear to a wedding?', answers: [] },
  { query: "I'm really tired today", answers: [] },
  { query: 'Sounds good, thanks!', answers: [] },
  { query: 'hey thomas', answers: [] },
  { query: 'yes', answers: [] },
  { query: 'Can you speak a little slower?', answers: [] },
  { query: 'what time is our call on Thursday?', answers: [] },
  { query: 'I emailed the three owners this morning.', answers: [] },
  { query: 'We met yesterday and picked the blue logo.', answers: [] },
  { query: 'My cofounder is traveling this week.', answers: [] },
  { query: 'The app crashed twice during the demo.', answers: [] },
  { query: 'I finished the two calls and sent you the notes.', answers: [] },
  { query: 'We sold four units at the fair on Saturday.', answers: [] },
  { query: 'who won the student government election?', answers: [] },
  { query: 'how many calories are in an avocado', answers: [] },
  { query: 'my phone will not turn on, what should i do?', answers: [] },
  { query: 'how do vaccines work', answers: [] },
  { query: 'what is a good show to watch tonight?', answers: [] },
  { query: 'how do I renew my passport?', answers: [] },
  { query: 'Is it going to snow during finals?', answers: [] },
  { query: 'what is the tallest building in the world', answers: [] },
  { query: 'can you help me memorize the periodic table', answers: [] },
  { query: 'Do you like music?', answers: [] },
  { query: 'I need a haircut, any barbers nearby?', answers: [] },
  { query: 'how do I get a parking permit', answers: [] },
];

/**
 * Written after the floors, topics and fusion were frozen, and never used to change them: what the measure says of
 * questions nobody looked at.
 */
export const RETRIEVAL_EVAL_FRESH: readonly EvalQuery[] = [
  {
    query:
      'the school district would be paying but teachers are the ones using it, so whose problem do I solve?',
    answers: [...USER, ...DISCOVERY],
  },
  { query: 'do advertisers count as customers', answers: [...USER, ...MODEL] },
  { query: 'we give the software away, what are our options to earn money from it?', answers: MODEL },
  { query: 'can someone explain the nine boxes of the canvas', answers: [...CANVAS, ...MODEL] },
  { query: 'if my roommate and I sell hoodies together are we automatically a partnership?', answers: LEGAL },
  { query: 'what does limited liability actually protect me from?', answers: LEGAL },
  { query: 'how much does it cost to set up a company in general', answers: [...LEGAL, ...REG, ...COSTS] },
  { query: 'do I need a lawyer to choose between LLC and C-corp?', answers: LEGAL },
  { query: 'where do i apply for a federal tax id', answers: EIN },
  { query: 'I made $450 tutoring on my own, do I owe self employment tax?', answers: TAX },
  { query: 'someone told me to file a provisional before the poster session, why?', answers: PATENT },
  { query: 'can a mere idea be patented?', answers: PATENT },
  { query: 'how do I know nobody already owns our brand name?', answers: [...TM, ...REG] },
  {
    query: 'I need to interview dentists and have no idea how to start the conversation',
    answers: [...DISCOVERY, ...NET],
  },
  {
    query:
      'my professor says do customer discovery but I already have a survey with 80 responses, is that enough?',
    answers: SURVEY,
  },
  {
    query: 'what is the cheapest way to test if people will pay?',
    answers: [...MVP, ...DISCOVERY, ...PRICE],
  },
  { query: "how long should my pitch be and what's the goal of it", answers: PITCH },
  {
    query: 'what do investors expect to hear about my team in a pitch?',
    answers: [...PITCH, ...TEAM, ...FUND],
  },
  { query: 'how do angel groups differ from VC funds', answers: FUND },
  { query: 'is bootstrapping realistic for a hardware product?', answers: [...BOOT, ...FUND] },
  { query: 'Do I need a lawyer before asking my friends to invest?', answers: [...SEC, ...FUND] },
  { query: 'what is dilution and should I worry about it', answers: [...FUND, ...BOOT] },
  { query: 'how do I keep in touch with mentors after the first meeting?', answers: NET },
  {
    query: 'what do I say in the first line of an email to a stranger I want to interview',
    answers: [...NET, ...DISCOVERY],
  },
  { query: 'can you give me a template for a lean business plan?', answers: [...PLAN, ...CANVAS] },
  { query: 'which expenses should I list before opening a small bakery?', answers: COSTS },
  { query: 'at $12 a unit and $7 cost, how many do I have to sell to break even?', answers: COSTS },
  {
    query: 'where can I find free data on how many dentists there are in New York?',
    answers: [...MARKET, ...DISCOVERY],
  },
  { query: 'two startups already do this, how do we stand out?', answers: COMP },
  {
    query: "I don't know whether to keep my internship offer or work on the startup full time",
    answers: [...TEAM, ...MINDSET],
  },
  { query: 'how do I convert a Word file to PDF?', answers: [] },
  { query: 'what is the best way to study for organic chemistry', answers: [] },
  { query: 'my girlfriend and I had a fight last night', answers: [] },
  { query: 'the printer on the second floor is broken again', answers: [] },
  { query: 'We changed the button color to green.', answers: [] },
  { query: 'can you recommend a good gym?', answers: [] },
  { query: 'is the library open on Sunday', answers: [] },
  { query: 'how do airplanes stay in the air?', answers: [] },
  { query: 'Ok I will do that this weekend', answers: [] },
  { query: 'who wrote The Great Gatsby', answers: [] },
  { query: 'how do I get a visa for Japan', answers: [] },
  { query: 'what should I name my cat?', answers: [] },
];
