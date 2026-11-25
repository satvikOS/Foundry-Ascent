/**
 * Notes on the Ain Foundry course videos (Modules 1 to 3), for the programme's own tenant: the method a founder asks
 * about (customer or user, the business model, legal structure, customer discovery, the pitch, fundraising,
 * bootstrapping, networking), said as the programme teaches it and cited by module, unit and timestamp.
 *
 * - Paraphrased, never copied: each note says in our words what a stretch of a video says, at most 550 characters, so
 *   the coach reads it whole. Presenters' names, their companies and biographies are left out, as in ./curriculum.ts.
 * - Advice is the programme's, opinions are marked as one founder's opinion, and a note that touches a requirement, a
 *   fee or the law says first who decides it.
 * - Asked for, not pushed: a note is a candidate only when the founder's own message asks about one of its source's
 *   topics (`knowledge-pack/topics.ts`), or the play the path chose cites its unit. They never take the slots of the
 *   coach's library or the programme handbook (`repositories/retrieval.ts`, the corpus lane).
 */
import type { CorpusSource } from '../knowledge-pack/corpus.js';

/** URI prefix of these notes: under `curriculum:`, so what is said of curriculum sources holds for them too. */
export const PROGRAMME_NOTES_URI_PREFIX = 'curriculum:notes/';

const PROGRAMME_URL = 'https://www.rochester.edu/aincenter/ain-foundry-program/';
const ATTRIBUTION =
  'Ain Center for Entrepreneurship and Innovation, University of Rochester: Ain Foundry course videos (paraphrased)';
const LICENCE = 'Programme material, paraphrased for the programme that made it';

interface Draft {
  readonly key: string;
  /** "Module 2, Unit 1". */
  readonly unit: string;
  readonly video: string;
  readonly topics: CorpusSource['topics'];
  readonly notes: readonly { readonly at: string; readonly heading: string; readonly content: string }[];
}

const DRAFTS: readonly Draft[] = [
  {
    key: 'm1u1-mindset-1',
    unit: 'Module 1, Unit 1',
    video: 'Entrepreneurial Mindset, Part I',
    topics: ['mindset', 'idea'],
    notes: [
      {
        at: '01:40-02:28',
        heading: 'Mindset is the part you control',
        content:
          'Mindset is described as the one thing a founder controls minute to minute: how they take the situation they ' +
          'are in. The situation is what it is; your thoughts about it are yours. Much of a new venture is outside your ' +
          'control, so decide early whether you can treat that turbulence as normal and still enjoy the work.',
      },
      {
        at: '02:28-03:52',
        heading: 'Know who you are as a leader',
        content:
          'Before committing to a venture, be clear about yourself: how you approach problems, what your core values ' +
          'are, and what kind of leader you are. The question to answer honestly is whether this way of working is ' +
          'something you can and want to take on.',
      },
      {
        at: '03:56-05:46',
        heading: 'What an entrepreneurial mindset is',
        content:
          'An entrepreneurial mindset combines open-mindedness, problem solving, willingness to listen, willingness to ' +
          'be wrong and correct course, and comfort with ambiguity. Many things will be new to you even with ' +
          'experience (a new market, a new skill, a new hire), and each has to be worked through on its own.',
      },
      {
        at: '05:46-06:40',
        heading: 'What you do not know yet',
        content:
          'If something can be known, find it out as quickly as possible; for what cannot, give yourself room and time ' +
          'to learn. What any founder already knows is a tiny part of what they need, so say when you do not know and ' +
          'call in experts.',
      },
      {
        at: '06:45-08:07',
        heading: 'Get out of the office and talk to people',
        content:
          'Going out to talk to customers and other people is called the core of the entrepreneurial mindset. Ideas are ' +
          'easy to have; the work is solving a real problem for real people. Hold your own idea of a solution lightly ' +
          'and focus on the problems the people around you have.',
      },
      {
        at: '08:07-09:00',
        heading: 'Talking to people is a skill to practise',
        content:
          'If talking to strangers is not your strength, treat it as a skill to learn rather than a reason to skip it. A ' +
          'good listener walks into a room with what they know and leaves with what everyone else knows as well: their ' +
          'experience and their problems.',
      },
      {
        at: '09:00-10:10',
        heading: 'The same mindset inside a company',
        content:
          'The entrepreneurial mindset is useful outside a start-up too: someone innovating inside an existing company ' +
          '(an intrapreneur) also needs an open mind, conversations with people and the humility to learn from them.',
      },
    ],
  },
  {
    key: 'm1u1-mindset-2-business-model',
    unit: 'Module 1, Unit 1',
    video: 'Entrepreneurial Mindset, Part II (business model)',
    topics: ['business-model'],
    notes: [
      {
        at: '03:31-05:26',
        heading: 'What makes a business model sound',
        content:
          'A business model answers two questions: what value reaches the customer, and how the company is paid for it. A ' +
          'sound one works for both sides. If it serves only the customer, the company cannot keep going; a good model ' +
          'gives customers enough value that they stay and keep paying, and lets the company keep delivering it.',
      },
      {
        at: '05:26-08:09',
        heading: 'One product, two opposite business models',
        content:
          'The same software can be sold in opposite ways. In one model, each user pays a one-time licence ($100 from a ' +
          'million users is $100 million). In the reverse, the company pays users to use it and earns by selling ' +
          'cleaned usage data to other companies; what it pays the users is then its cost, and what is left is gross ' +
          'profit. Same product, different customer.',
      },
      {
        at: '08:09-08:37',
        heading: 'Test the business model with customers',
        content:
          'Whether a business model works is found out by talking to customers, every kind of customer the model ' +
          'involves: is this something they want or need, and will they pay for it under these conditions?',
      },
    ],
  },
  {
    key: 'm1u1-mindset-2-team',
    unit: 'Module 1, Unit 1',
    video: 'Entrepreneurial Mindset, Part II (team and job security)',
    topics: ['team', 'job-security'],
    notes: [
      {
        at: '00:07-03:21',
        heading: 'Job security or entrepreneurship',
        content:
          "One founder's opinion, offered as an opinion: a job where others set the budget and decide who stays is not " +
          'more secure than a venture that keeps talking to customers and moves with its market. The video says not to ' +
          'turn a job down because of it: how secure each path feels differs from person to person.',
      },
      {
        at: '08:46-10:22',
        heading: 'The team matters more than the idea',
        content:
          'A strong team with an average idea beats an average team with a strong idea, because the strong team changes ' +
          'the idea when customer conversations say so. Look for people you respect and enjoy working with, who share ' +
          'the goal and the vision.',
      },
      {
        at: '10:37-11:49',
        heading: 'Choose teammates who think differently',
        content:
          'Seek people who challenge you, think differently and fill the gaps in what you do well: different views of ' +
          'the customer, the technology and the world. A room where everyone thinks the same adds little. Every team ' +
          'has trials, so working with people you respect is worth protecting.',
      },
    ],
  },
  {
    key: 'm1u1-mindset-2-funding',
    unit: 'Module 1, Unit 1',
    video: 'Entrepreneurial Mindset, Part II (funding)',
    topics: ['fundraising', 'bootstrapping', 'investors'],
    notes: [
      {
        at: '12:49-13:32',
        heading: 'Get advice before asking anyone for money',
        content:
          'Get professional advice first: an attorney decides what applies to you. Different laws cover different ' +
          'situations, and only talking to someone about trading stock for cash can make it a securities transaction. ' +
          'The video says to ask for advice before trying to raise more than your own money.',
      },
      {
        at: '13:32-14:25',
        heading: 'Start with your own cash and what the business earns',
        content:
          'Bootstrapping means using your own cash, cash from friends and family, or funds the business itself earns, ' +
          'and putting each bit of cash back into operations. It is called a great way to start: you keep all the ' +
          'equity, or give a little to people close to you.',
      },
      {
        at: '14:25-15:24',
        heading: 'Angel investors have terms',
        content:
          'Angel investors are individuals who put their own money in early, sometimes with the first checks that start ' +
          'a company. They may be kind, but it is real money: expect terms, and expect them to want protection. Raise ' +
          'from them with the guidance of an attorney and a securities professional.',
      },
      {
        at: '15:24-16:08',
        heading: 'How venture capital works',
        content:
          'Venture capital is professional money: a fund raises it from others, and its manager invests it on their ' +
          'behalf and must return it with a gain. It is a portfolio model: the fund bets that a certain share of its ' +
          'companies will make it, not that every one will. The checks tend to be larger.',
      },
      {
        at: '16:17-16:45',
        heading: 'Rough sizes of early money',
        content:
          "One founder's rough sizes, not limits: a few hundred to a few thousand dollars of your own to incorporate and " +
          'start marketing, perhaps up to $10,000 from friends and family, $25,000 to $50,000 from an angel or two. ' +
          'Beyond that is usually a seed fund or a venture capital firm.',
      },
      {
        at: '16:45-18:09',
        heading: 'When not to raise money',
        content:
          "Opinions range from never take investors' money to always use other people's. The middle view: let the unit " +
          'economics decide. If more cash would not speed up your entry to the market or your capture of a segment, and ' +
          'you can grow on your own cash and keep your shares, you may not need investors.',
      },
      {
        at: '18:09-19:39',
        heading: 'When raising money makes sense',
        content:
          'Raising can be worth the dilution when the unit economics already show what cash returns and the market must ' +
          'be captured quickly to hold a competitive position: a smaller share of a much bigger company can be worth ' +
          'more. Answer two questions first: why are you taking the money, and will it help capture value quickly at ' +
          'this point in time?',
      },
    ],
  },
  {
    key: 'm1u2-customer-vs-user',
    unit: 'Module 1, Unit 2',
    video: 'Key term: customer vs. user',
    topics: ['customer-user'],
    notes: [
      {
        at: '00:16-01:57',
        heading: 'The user is not always the customer',
        content:
          'The user uses the product; the customer pays for it, and they can be different people. With children’s ' +
          'cereal the child is the user and the parent is the customer. Reach both: make the child want it, and give ' +
          'the parent a reason to buy, such as a coupon or a sale in the store.',
      },
      {
        at: '01:57-02:49',
        heading: 'When advertisers are the customer',
        content:
          'Example: a magazine given free to high school students. The students who read it were the users; the ' +
          'advertisers who paid for space were the customers and brought the revenue. It had to be marketed to both. ' +
          'Remember that your user is not necessarily your customer, and fit your marketing to each.',
      },
    ],
  },
  {
    key: 'm1u2-business-model',
    unit: 'Module 1, Unit 2',
    video: 'Key term: business model',
    topics: ['business-model'],
    notes: [
      {
        at: '00:15-01:00',
        heading: 'How does your company make money?',
        content:
          'The business model is deeper planning: literally how the company makes money. Is it a product, a service, a ' +
          'retail place or an online business? How is it sold: directly, to businesses (B2B), to consumers (B2C), by ' +
          'franchising or by licensing?',
      },
      {
        at: '01:00-01:54',
        heading: 'Your North Star: the one number that moves revenue',
        content:
          'Find the one measure that has to move for the business to earn: the North Star that you, your team, your ' +
          'customers and your investors all understand. For a podcast paid by sponsors it is downloads, because more ' +
          'downloads sell more advertising. Make yours clear in the business model.',
      },
      {
        at: '01:54-02:08',
        heading: 'Four questions for a business model',
        content:
          'Answer four questions: what is your product, who is it for, how does it reach them (online, retail, ' +
          'franchising, licensing or direct sales), and what is the one thing you drive to create revenue?',
      },
    ],
  },
  {
    key: 'm1u2-canvas',
    unit: 'Module 1, Unit 2',
    video: 'Key term: Business Model Canvas',
    topics: ['canvas'],
    notes: [
      {
        at: '00:13-01:04',
        heading: 'Why use a Business Model Canvas',
        content:
          'The Business Model Canvas is a one-page document that lets you and your team think out, picture and explain ' +
          'the concepts of the business. It fits the lean start-up approach: make a minimal version and see where the ' +
          'market takes you before investing a lot of money. It is simple to set up as a team brainstorm.',
      },
      {
        at: '01:04-01:47',
        heading: 'What the canvas covers, and when to revisit it',
        content:
          'The Business Model Canvas helps you think through your finances, value proposition, infrastructure and ' +
          'customer base on one visual page: a dashboard and a one-page strategic plan. It is a live document to ' +
          'revisit regularly, and most valuable right at the beginning.',
      },
    ],
  },
  {
    key: 'm2u1-legal-structure',
    unit: 'Module 2, Unit 1',
    video: 'Key term: legal structure',
    topics: ['legal-structure'],
    notes: [
      {
        at: '00:23-00:47',
        heading: 'Who decides the legal structure',
        content:
          'Consult a lawyer and an accountant before choosing: the right legal structure depends on the type of ' +
          'business, your plans for growth, the protection you need and the tax structure.',
      },
      {
        at: '00:38-01:18',
        heading: 'A DBA is the quickest start, without protection',
        content:
          'Confirm the process and the current fee with your county clerk (the video recalls about $33). A DBA, ' +
          '"doing business as", is the easiest start: check at the county clerk’s office that the name is free, and ' +
          'you can be in business that day. Its problem: it does not separate you from the business, so someone who ' +
          'sues the business can sue you too.',
      },
      {
        at: '01:18-01:56',
        heading: 'Structures to look into',
        content:
          'Ask a lawyer and an accountant which fits. To protect yourself, the video names LLCs, S corporations and C ' +
          'corporations, beside sole proprietorships (on your own) and partnerships. They differ in how they protect ' +
          'you and in how they are taxed; read about each term before the meeting.',
      },
      {
        at: '01:56-02:20',
        heading: 'Legal structure when you plan to raise money',
        content:
          'Confirm with a lawyer and an accountant: which structure suits raising money depends on the investors, as ' +
          'different kinds of company suit different investors. Do your own research first, then decide with them.',
      },
    ],
  },
  {
    key: 'm2u1-customer-discovery',
    unit: 'Module 2, Unit 1',
    video: 'Key term: customer discovery',
    topics: ['customer-discovery', 'mvp'],
    notes: [
      {
        at: '00:08-00:38',
        heading: 'Founders are partly wrong about their customer',
        content:
          'Customer discovery is hearing the voice of the customer: finding out who your real customer is. Founders ' +
          'think they know who the customer is and what they want, and nearly always they are wrong to some extent, so ' +
          'find out before spending time and money on what you think is right.',
      },
      {
        at: '00:38-01:17',
        heading: 'Interview potential customers first',
        content:
          'Before you go big, do some research: interview potential customers, face to face or on video if you can. ' +
          'Talk to them, see whether this is something they would be interested in, and get their feedback.',
      },
      {
        at: '01:17-01:53',
        heading: 'The real test: will they buy it?',
        content:
          'People may tell you what you want to hear because they are trying to be nice. The proof in customer ' +
          'discovery is whether they buy: set up a minimum viable product, offer a version that is not too expensive, ' +
          'and see whether they pay for it.',
      },
      {
        at: '01:53-02:32',
        heading: 'Learn from what they buy instead',
        content:
          'If they do not buy, find out why. Offer a few choices and watch where buying habits go: you may expect them ' +
          'to love one option and find they want another. Customers who pay are giving you research with their dollars.',
      },
      {
        at: '02:32-03:05',
        heading: 'Ready, aim, then fire',
        content:
          'Many founders fire before they aim. Lean start-up customer discovery lets you walk before you run: spend ' +
          'longer getting ready and aiming, with interviews and a minimum viable product, before you launch.',
      },
    ],
  },
  {
    key: 'm2u2-pitch',
    unit: 'Module 2, Unit 2',
    video: 'Key term: the pitch',
    topics: ['pitch'],
    notes: [
      {
        at: '00:15-00:44',
        heading: 'When you need a pitch',
        content:
          'You pitch when the business has reached a level where scaling makes sense and outside money may be needed. ' +
          'That usually takes a pitch deck, a fuller business plan and some financial modelling, adjusted for each type ' +
          'of investor.',
      },
      {
        at: '00:44-01:13',
        heading: 'The plan is for you, the deck is for investors',
        content:
          'Investors rarely read a hundred-page business plan now. Write a detailed plan for your own use (marketing, ' +
          'financials, sales, culture) and pitch with a deck, usually about 12 slides that give the overview.',
      },
      {
        at: '01:13-01:36',
        heading: 'What a 10-minute pitch must make clear',
        content:
          'After a pitch of about ten minutes the listener should get it: the problem you are trying to solve, who your ' +
          'audience is and what their problem is, your unique solution, and the team that will make it happen.',
      },
      {
        at: '01:36-02:10',
        heading: 'Making the pitch deck aligns the team',
        content:
          'Preparing a pitch deck is useful even without the money: it makes the team think the whole business through, ' +
          'check that the mission is clear and row in the same direction.',
      },
      {
        at: '02:10-03:06',
        heading: 'Put your one metric in the pitch',
        content:
          'Name the one metric that moves the needle and make it clear in the pitch. For a podcast paid by sponsors it ' +
          'is downloads: more downloads bring more advertising. Say what the equivalent is for your business, to ' +
          'investors and to your team.',
      },
    ],
  },
  {
    key: 'm3u1-fundraising',
    unit: 'Module 3, Unit 1',
    video: 'Key term: fundraising',
    topics: ['fundraising', 'investors'],
    notes: [
      {
        at: '00:22-01:13',
        heading: 'Bootstrap before you fundraise',
        content:
          'Bootstrapping at the start keeps your freedom: no equity given up and no investors to answer to, though ' +
          'advice and an advisory board still help. With no big bag of money to throw at a problem you have to get ' +
          'creative, which is how good ideas are often born.',
      },
      {
        at: '01:13-02:05',
        heading: 'What a venture capital firm brings and wants',
        content:
          'A venture capital firm listens to pitches and decides whether to invest. Besides money it often brings ' +
          'experience with companies that succeeded, and it usually wants a seat on the board. Reach out to ask such ' +
          'people for advice and technical and managerial expertise, not only for money.',
      },
      {
        at: '02:05-02:35',
        heading: 'What angel investors want',
        content:
          'Angel investors are usually high-net-worth individuals, some of whom want to give back to entrepreneurs as ' +
          'well as earn. They often fund a start-up’s first round and typically want equity or convertible debt.',
      },
      {
        at: '02:35-02:59',
        heading: 'Convertible debt in plain words',
        content:
          'An attorney should read any such terms. Convertible debt goes on the books as a loan first. After an agreed ' +
          'time (the video’s example is two years) the investor can take the money back with interest, or leave it in ' +
          'the company so that it grows with the company.',
      },
      {
        at: '02:59-04:04',
        heading: 'Seed, then Series A, B, C and D',
        content:
          'Seed funding comes first; a venture capital firm may provide it and then move to later stages, Series A and ' +
          'then B, C and D. Firms may specialize in kinds of business and in the round they fund, and usually want a ' +
          'board position to help with the next stage.',
      },
      {
        at: '04:04-04:21',
        heading: 'Talk to people in the field before raising',
        content:
          'Before moving forward with a raise, spend time with people who work in fundraising and pick their brains; it ' +
          'is presented as what a founder did before raising money for a company.',
      },
    ],
  },
  {
    key: 'm3u1-bootstrapping',
    unit: 'Module 3, Unit 1',
    video: 'Key term: bootstrapping',
    topics: ['bootstrapping'],
    notes: [
      {
        at: '00:22-01:08',
        heading: 'What bootstrapping means',
        content:
          'Most founders start by bootstrapping: finding ways to survive without raising money in the beginning. ' +
          'Examples given: building the first company by day while waiting tables at night, and borrowing from friends ' +
          'and family.',
      },
      {
        at: '01:08-01:42',
        heading: 'Bootstrapping keeps equity and control',
        content:
          'Bootstrapping means not giving up equity. Investors want their money out someday, so taking it gives you ' +
          'people to answer to. If staying bootstrapped makes sense, you keep control over standards, product, quality ' +
          'and culture.',
      },
      {
        at: '01:42-02:48',
        heading: 'Bootstrapping forces creativity',
        content:
          'Without a bag of money for each problem, you and your team have to figure things out and find creative ' +
          'solutions. The video calls that the best thing about bootstrapping, and the experience a boot camp for what ' +
          'comes later.',
      },
    ],
  },
  {
    key: 'm3u2-networking-1',
    unit: 'Module 3, Unit 2',
    video: 'Networking I',
    topics: ['networking', 'cofounder', 'idea-sharing'],
    notes: [
      {
        at: '03:22-05:32',
        heading: 'Networking is building relationships',
        content:
          'Networking is building relationships: meeting people, hearing their story and learning from them. Other ' +
          'people are among the best ways to learn, so the more people you meet, the more chances you have to learn ' +
          'from their experience.',
      },
      {
        at: '05:32-07:07',
        heading: 'Why founders have to network',
        content:
          'A venture has to understand its market, audience, customers, end users and other stakeholders, which means ' +
          'talking to them; otherwise the idea stays an idea. In the example, reaching out to many universities ended ' +
          'with the product launched at five and relationships with dozens more.',
      },
      {
        at: '07:07-08:35',
        heading: 'Find co-founders by networking',
        content:
          'Not having every skill the idea needs is normal, so the first founder’s first step is a team: people ' +
          'interested in the same problem. Classmates, colleagues, people met at a conference or on LinkedIn can become ' +
          'co-founders. Start the interaction and let stronger relationships form.',
      },
      {
        at: '08:45-10:10',
        heading: 'Introverts can network too',
        content:
          'Networking is uncomfortable for many people at first, and cold outreach makes most of us nervous. Being an ' +
          'extrovert is not required: an introvert can be a good networker. Do not let your personality type become a ' +
          'barrier.',
      },
      {
        at: '10:10-11:30',
        heading: 'The worst they can say is no',
        content:
          'It is normal to worry about being ignored or wasting someone’s time. The worst answer is no, and you need one ' +
          'yes: the person who connects you with a paying customer or the right co-founder. It is trial and error, and ' +
          'bad calls happen to everyone.',
      },
      {
        at: '11:30-12:41',
        heading: 'Being a student helps you reach people',
        content:
          'College is one of the best times to network. Everyone was a student once, founders remember their own learning ' +
          'curve, and many people like to help students and pay it forward.',
      },
      {
        at: '12:41-13:39',
        heading: 'Get feedback instead of sitting on the idea',
        content:
          'An idea nobody has heard is probably not yet a good one. Do not wait for funding to start: talk to friends, ' +
          'strangers and professors, and ask them about the problem. While you sit on the idea, someone else may be ' +
          'building it.',
      },
      {
        at: '13:39-15:35',
        heading: 'Will someone steal my idea?',
        content:
          'Fear of idea theft kept the presenter silent for months; the lesson is to share. Few people have the time to ' +
          'build your idea. You need not reveal protected or secret parts: describe the problem and a high-level idea. ' +
          'People who give feedback often become supporters and collaborators, and progress came only after sharing.',
      },
    ],
  },
  {
    key: 'm3u2-networking-2',
    unit: 'Module 3, Unit 2',
    video: 'Networking II',
    topics: ['networking', 'outreach'],
    notes: [
      {
        at: '02:07-03:38',
        heading: 'Use LinkedIn to find customers and investors',
        content:
          'LinkedIn is recommended as a free way to find and reach potential users, customers, investors and other ' +
          'stakeholders in any industry. Set up a profile now. Almost everyone struggles with a first cold message, and ' +
          'people are there to connect.',
      },
      {
        at: '03:38-04:45',
        heading: 'Write a connection request that gets a yes',
        content:
          'Always add a personal message to a LinkedIn request: one sentence on who you are, why you want to connect with ' +
          'this person, and an ask at the end, such as a few minutes to talk. The limit is short (the video says about ' +
          '300 characters), and it can be done.',
      },
      {
        at: '04:45-05:39',
        heading: 'Make outreach genuine, not transactional',
        content:
          'Do not open with a request for a referral or a resume review; people ignore it. Read their profile and name ' +
          'what you share: the same school, major, club or interest. That makes it relatable and easier for them to ' +
          'answer.',
      },
      {
        at: '05:39-06:44',
        heading: 'Cold emails: short, with a reason and an ask',
        content:
          'Keep a cold email very short: nobody reads a long paragraph. Open with a line that gets attention, give the ' +
          'person a reason to connect, and ask for something small. Example: name a problem you have seen in their ' +
          'field, say you are working on it, and ask for 15 minutes to learn how they handle it.',
      },
      {
        at: '06:44-07:20',
        heading: 'You only need one reply',
        content:
          'People like talking about themselves, so asking to learn about their job or department usually works. Try ' +
          'different ways of writing the email. Not everyone will answer; the one who does is what you need.',
      },
      {
        at: '07:20-08:38',
        heading: 'Video calls with someone new',
        content:
          'On a video call, be prepared and know what you want to talk about. Turn the camera on if you are comfortable, ' +
          'or when the other person has theirs on. Look at the person, and keep any notes next to the screen.',
      },
      {
        at: '08:38-09:51',
        heading: 'Breaking the ice with a stranger',
        content:
          'Starting with a stranger can be awkward for both of you. Use a little small talk (their day, the weather, ' +
          'where they are based) to get the conversation moving, then go to your questions. Preparation helps.',
      },
      {
        at: '09:51-11:57',
        heading: 'Networking at an event',
        content:
          'At an event be ready to introduce yourself and to ask relevant questions. Notice whether the person is in a ' +
          'hurry, smile, and get them talking about themselves before you come in; do not turn it into an ' +
          'interrogation. If they leave, there are others to talk to.',
      },
      {
        at: '11:57-13:24',
        heading: 'Before and during the call: research, introduce, set the tone',
        content:
          'First tips: research the person so your questions are relevant; introduce yourself in one or two sentences, ' +
          'with the problem you are solving and why you want to talk to them; then set the tone, for example that you ' +
          'would like to learn about their experience in a customer discovery interview, and ask if that is fine.',
      },
      {
        at: '13:24-14:37',
        heading: 'End with an ask, then follow up',
        content:
          'End every conversation with an ask: an introduction, help with something, or permission to come back. Then ' +
          'keep the relationship: keep a tracker of who you met and why, and check in about every three months with ' +
          'something relevant to your last conversation.',
      },
      {
        at: '14:37-15:10',
        heading: 'Send a thank-you email',
        content:
          'Send a thank-you email of two or three sentences soon after the call. When you meet someone in person, get ' +
          'their contact details, LinkedIn or business card.',
      },
    ],
  },
];

export const PROGRAMME_NOTES: readonly CorpusSource[] = DRAFTS.map((d) => ({
  key: d.key,
  uri: `${PROGRAMME_NOTES_URI_PREFIX}${d.key}`,
  title: `Ain Foundry ${d.unit}: ${d.video}`,
  kind: 'note',
  topics: d.topics,
  playSources: ['ain-curriculum', 'ain-foundry'],
  url: PROGRAMME_URL,
  licence: LICENCE,
  attribution: ATTRIBUTION,
  accessedOn: '2026-11-24',
  notes: d.notes.map((n) => ({
    heading: n.heading,
    content: n.content,
    locator: `${d.unit}, ${d.video}, ${n.at.replace('-', ' to ')}`,
  })),
}));
