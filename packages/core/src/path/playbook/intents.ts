import type { PathIntent } from '../types.js';

/**
 * One intent per play, under the play's own id, and a few said in passing (`note`) that only bring who to see. Phrases are
 * lines: typed and spoken, short and blunt, with the misspellings and speech-to-text slips students make; `...` stands for
 * a few words. `unless` names words that make it another ask.
 */
const intent = (
  id: string,
  phrases: string,
  more: Partial<Pick<PathIntent, 'playId' | 'unless' | 'referral' | 'overview' | 'note' | 'holds'>> = {},
): PathIntent => ({
  id,
  playId: id,
  phrases: phrases
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== ''),
  ...more,
});

export const INTENTS: readonly PathIntent[] = [
  // Idea
  intent(
    'get-organized',
    `
    get me organized around my venture idea
    help me organize my idea
    I have a startup idea, what do I do with it
    student founder with an app idea
    I'm a student founder and my idea is a service for students
    my idea is a campus app
    I have a business idea and don't know how to start
    where do I start with my idea
    how do I get started on my startup idea
    got an idea, now what
    help me plan my startup from the beginning
    organise me
    i wanna start a buisness where do i begin
    I want to turn my idea into a plan
    make me a plan for my idea
    help me build my venture from scratch
    let's plan my venture
    `,
    { overview: 'path', unless: ['competitor', 'similar', 'lab'] },
  ),
  intent(
    'start-from-zero',
    `
    idea stage and I've never done this
    engineering student with no idea about business
    I don't know anything about business
    I have no business background
    first time founder, no idea what I'm doing
    I've never started a company before
    I have zero business knowledge
    do I need a business degree to start a company
    total beginner at startups
    explain it to me like I know nothing about business
    I'm a science major and clueless about business
    never took a business class can i still do this
    psychology student with no clue about companies
    zero experience with startups, is it ok
    business is all new to me and I study science
    total newbie at running a business
    never taken a business class, can I do it
    `,
    { overview: 'play' },
  ),
  intent(
    'what-next',
    `
    what should I do next
    what's my next step
    what do I do now
    where am I on the path
    what stage am I in
    what should I work on this week
    what should I focus on right now
    tell me the next thing to do
    I did that, what's next
    give me my steps for this week
    whats next
    next step please
    how far along am I
    what is the most important thing to do this week
    done, next
    finished that step, next one
    `,
    {
      overview: 'path',
      unless: ['ain', 'leave', 'graduate', 'graduation', 'graduating', 'pivot', 'pivoted'],
    },
  ),
  intent(
    'real-business',
    `
    is my delivery idea a real business
    a real business or just a project
    would this be a real business
    is my idea a real business or just a hobby
    could this be an actual business
    is this viable
    is my idea viable as a business
    is this worth pursuing
    does this idea have potential to be a company
    is it a business or a side project
    would this work as a business
    can you make money with an idea like this
    is this legit a business idea
    could it be a proper business
    `,
  ),
  intent(
    'idea-on-a-page',
    `
    help me write my idea on one page
    summarize my idea in one page
    help me describe my idea clearly
    how do I write down my business idea
    turn my idea into a one pager
    help me explain my idea in simple words
    write up my idea
    I can't explain what my idea is
    lean canvas for my idea
    make a one page summary of my startup
    help me put my idea into words
    short written summary of the startup
    idea on a single page
    `,
    { unless: ['pitch', 'landing'] },
  ),
  intent(
    'idea-or-problem',
    `
    what's the difference between an idea and a problem
    how do I know what problem I'm solving
    help me find the problem behind my idea
    I have a solution but not sure about the problem
    write a problem statement
    what problem does my product solve
    solution looking for a problem
    is this problem real
    how do I find a problem worth solving
    I have the tech but no problem for it
    is my problem big enough to solve
    find out what problem people actually have
    what problems do people really have
    `,
  ),
  intent(
    'pick-an-idea',
    `
    which idea should I pick
    I have three ideas and can't choose
    how do I choose between two startup ideas
    help me decide which idea to work on
    I have too many ideas
    which of my ideas is better
    I can't decide between ideas
    I keep jumping between ideas
    idea a or idea b
    pick one of my ideas
    how do I come up with a startup idea
    I want to start something but have no idea
    torn between two ideas, pick one
    choose one for me, an app or a product
    which of these ideas is best
    two ideas and can't decide which one
    between two ideas, pick one for me
    `,
  ),
  intent(
    'friends-love-it',
    `
    friends love the idea, is it proof
    friends all love it, does it mean the idea is good
    everyone I know thinks it's great
    my roommates love my idea
    my family thinks this is a good idea
    all my friends would use it
    my friends said they'd buy it
    is it enough that my friends like it
    people I know are excited about it, does that count
    my mom loves it lol is that validation
    friends think its awesome so should i build it
    people close to me like it
    `,
  ),
  intent(
    'biggest-reason-to-fail',
    `
    biggest reason it could fail
    why would my idea fail
    what could go wrong with my startup
    what's the biggest risk in my idea
    what kills startups like mine
    what is the weakest part of my idea
    what am I missing about my idea
    poke holes in my idea
    play devil's advocate on my idea
    tell me why this won't work
    what assumptions am I making
    what is my most dangerous assumption
    what could sink this
    `,
  ),
  intent(
    'honest-read',
    `
    my idea is great
    is my idea good
    what do you think of my idea
    do you like my idea
    be honest, is my idea any good
    rate my idea out of 10
    just tell me it's a good idea
    say something nice about my idea
    give me honest feedback on my idea
    is my idea stupid
    am I onto something big
    roast my idea
    be brutally honest about my startup
    hype me up about my idea
    say it's a winner
    say my idea is amazing
    tell me it is brilliant
    `,
  ),
  intent(
    'customer-user-buyer',
    `
    what's the difference between a customer and a user
    who is my customer versus my user
    who is actually paying, the user or the buyer
    students use it but the university pays
    parents pay but kids use it
    the person using it is not the one buying it
    who should I sell to, the user or the one who pays
    user vs customer
    is my customer the student or the school
    who is the buyer
    nurses use it but the hospital pays, who is the customer
    confused about who uses it and who pays
    should I sell to the university or to the students
    sell this to the school or to parents
    who pays, the library or its users
    `,
    { unless: ['10', 'ten'] },
  ),
  intent(
    'other-teams-privacy',
    `
    another student is building something similar
    what do you know about the other founder's plan
    what are other founders in the program working on
    tell me what another founder told you
    what did the other team pitch to investors
    can you share another student's plan
    what have other students told you about their startups
    do you know what my competitor at Ain is doing
    who else in my cohort has an idea like mine and what is their plan
    show me another team's pitch deck
    what ideas do other teams here have
    is my information shared with other founders
    can other founders here see what I tell you about us
    is what I say private from other teams
    the other team in my cohort
    is anyone else in the program working on this and what are they planning
    which other ventures here do this and what do they charge
    you coach them too, give me a hint
    what are the other founders you coach doing
    somebody else here is building something like mine, what did they tell investors
    `,
    { holds: true },
  ),
  intent(
    'someone-has-my-idea',
    `
    someone is already doing my idea
    I found a company that does exactly what I want to do
    somebody else is building the same thing
    my idea already exists
    a startup just launched my idea
    should I quit because someone has the same idea
    big company is copying my idea
    someone stole my idea
    google could just do this
    there's already an app for this
    another company beat me to it
    someone already made my app should i give up
    somebody just launched the same product
    `,
    { unless: ['plan'] },
  ),
  intent(
    'share-the-idea',
    `
    will someone steal my idea if I share it
    should I make people sign an NDA
    do I need an nda before talking about my idea
    how do I keep my idea secret
    I'm scared to tell people my idea
    is it safe to talk about my idea
    how much should I tell people about my idea
    should I keep my idea secret
    non disclosure agreement for interviews
    afraid of people copying me if I tell them
    worried that somebody will steal it if I talk about it
    what if someone steals my idea
    can I tell people about my startup idea
    make people sign something before I share it
    `,
    { unless: ['patent', 'investors', 'lab'] },
  ),
  intent(
    'student-ip',
    `
    made in a university lab, who owns the rights
    part of the idea came from a university lab
    does the university own my invention
    who owns the intellectual property from my research
    do I own what I made in class
    my professor helped me build it, who owns it
    does my school own my startup
    I used lab equipment, do I have rights to it
    I made this during my PhD, is it mine
    can I license my research from the university
    technology transfer office
    what does UR Ventures do
    my advisor says the lab owns the code
    I built it in my professors lab is it still mine
    do grants affect who owns my invention
    my advisor and I are co-inventors, who has the rights
    rights to an invention from my thesis
    made it with grant money as a grad student, do I own it
    take ... and start our own company
    my advisor says we can each take it
    `,
    { referral: true },
  ),
  intent(
    'sign-ip-form',
    `
    the lab wants me to sign an IP form
    sign an IP form
    should I sign the invention agreement
    do I sign the IP assignment
    they want my signature on an intellectual property form
    my professor gave me an agreement to sign about the invention
    sign over my invention to the university
    assignment of rights form from the lab
    what happens if I sign the IP agreement
    is it safe to sign the lab's form
    the university wants me to sign away my rights
    `,
    { referral: true },
  ),
  intent(
    'lab-work-said',
    `
    my advisor is on the paper
    my advisor is a coauthor
    my supervisor helped invent it
    it came out of my thesis
    my thesis work
    my dissertation work
    my dissertation research
    we made it in the lab
    I built it in my lab
    from my PhD research
    came out of my PhD
    it is funded by a federal grant
    my PI is a co-inventor
    paper with my professor
    `,
    { playId: 'student-ip', note: true },
  ),
  intent(
    'going-public-said',
    `
    presenting ... at a conference
    presenting ... results
    the abstract goes public
    my poster is at a conference
    our paper comes out
    we are publishing the paper
    my conference talk is
    I will present the invention
    `,
    { playId: 'patent-now-or-wait', note: true },
  ),
  intent(
    'visa-said',
    `
    I'm here on a student visa
    I am on a student visa
    I'm on an F-1 visa
    I'm on an F1 visa
    I'm on a J-1 visa
    I am an international student
    I'm an international student here
    my visa is tied to my program
    `,
    { playId: 'international-student', note: true },
  ),

  intent(
    'biotech-path',
    `
    PhD with a biotech idea, which path
    how do I start a biotech company as a student
    I have a medical device idea, where do I start
    I have an idea for a drug
    path for a life science startup
    I'm a grad student with a therapeutics idea
    how do I commercialize my lab research
    turning my research into a company
    medtech idea what do i do first
    I'm in a biology lab and want to start a company
    diagnostic test startup, what are the steps
    deep tech startup from my thesis
    gene or cell therapy from my PhD
    startup based on a molecule we found
    `,
    { referral: true },
  ),
  intent(
    'no-tech-skills',
    `
    I can't code, how do I build this
    I'm not a programmer, can I still make the app
    I'm not technical, do I need a technical cofounder
    how do I start without a developer
    should I hire a developer to build my app
    I don't know how to code
    how can I make an app without coding
    nontechnical founder, what do I do
    should I pay an agency to build my app
    I need someone to build my app for me
    can i build it with no code tools
    where do I get an app developer
    I can't program it myself, who can build it
    zero coding skills
    `,
  ),
  intent(
    'time-with-classes',
    `
    how do I balance my startup with classes
    I don't have time for my startup
    I have exams and can't work on my venture
    how many hours a week should I spend on this
    I'm too busy with school
    how do I manage my time as a student founder
    finals are coming, what do I do about the startup
    I only have a few hours a week
    I'm falling behind in school because of my startup
    how do I fit this around my coursework
    midterms are killing me no time for the business
    no time for the startup with school
    only a few hours a week with all my classes
    `,
  ),
  intent(
    'stuck',
    `
    I'm stuck
    I feel stuck on my startup
    I lost motivation
    I keep procrastinating on my startup
    I don't feel like working on this anymore
    I'm overwhelmed with everything
    I'm burned out
    I'm scared to talk to customers
    I don't think I'm cut out to be a founder
    I feel like an imposter
    nothing is working and i feel down about it
    how do I stay motivated
    I'm discouraged
    `,
  ),
  intent(
    'job-or-startup',
    `
    should I take a job or do my startup
    should I drop out to work on my startup
    internship or startup this summer
    I got a job offer but I want to keep building
    should I do this full time
    is it safer to get a job first
    should I quit my job to start a business
    startup or grad school
    is entrepreneurship too risky compared to a job
    should i turn down the internship
    job security versus starting a company
    take the offer or build my own thing
    should I leave school for this
    `,
    { unless: ['graduate', 'graduation', 'graduating'] },
  ),
  intent(
    'foundry-path',
    `
    what are the modules in the Ain Foundry
    what do I have to do in the Foundry program
    what is the Ain Foundry curriculum
    how does the Foundry program work
    what are the capstones
    what do I need to finish module 1
    what is due for the Foundry
    which module am I supposed to do
    explain the three modules
    what do we learn in module 3
    what is the Ain Center program
    foundry requirements
    what does module 1 or module 2 include
    `,
  ),
  intent(
    'name-and-brand',
    `
    what should I name my startup
    help me pick a company name
    do I need a logo
    is this name taken
    how do I trademark my name
    should I buy the domain
    naming my business
    help with branding
    can I use this name for my company
    how do I choose a brand name
    someone has the same name as my startup
    what do I call my company
    what to call it
    `,
  ),
  intent(
    'social-venture',
    `
    should I start a nonprofit or a company
    my idea is a social enterprise
    I want to help people, not make money
    how does a social venture make money
    nonprofit versus for profit
    I want to start a charity
    my startup is for social impact
    how do I fund a social impact project
    can a nonprofit charge for things
    we want to help low income families
    register as a nonprofit for hunger or homelessness
    make a difference in my community
    nonprofit or LLC for a community project
    `,
  ),
  intent(
    'international-student',
    `
    can I start a company on a student visa
    I'm an international student, can I have a startup
    I'm on F-1, can I work on my own business
    can I earn money from my startup on an F1 visa
    does my visa let me be a founder
    can I use OPT for my startup
    is it legal for me to own a company as an international student
    cpt for my own startup
    I have a J-1 visa and want to start a business
    will my startup affect my immigration status
    im international can i get paid from my company
    F-1 student, a customer wants to pay me, is that allowed
    on a student visa, can I pay myself
    visa rules for running a business
    working for my own startup as an international student
    `,
    { referral: true, unless: ['mastercard'] },
  ),
  // Discovery
  intent(
    'find-ten-people',
    `
    who is my customer and where do I find ten
    who is my customer
    how do I find people to interview
    where do I find potential customers to talk to
    I don't know who my target customer is
    how do I find 10 people to talk to
    who should I talk to first
    how do I find my target audience
    where do I find early customers for interviews
    I don't know anyone in my target market
    how many people should I interview
    help me figure out who my customer is
    find people with this problem
    how many customers to interview and where to find them
    `,
    { unless: ['user', 'users', 'paying'] },
  ),
  intent(
    'interview-script',
    `
    what questions should I ask in customer interviews
    write me an interview script
    how do I do a customer interview
    help me prepare for a problem interview
    give me questions to ask customers
    how do I run customer discovery
    what is customer discovery
    interview guide for customer discovery
    how should I talk to customers
    what do I say in a customer discovery call
    questions for problem interviews
    how to interview users
    what do I ask customers about their problem
    what do I ask people
    `,
    { unless: ['job', 'internship', 'hire', 'hiring', 'survey', 'not', 'avoid', 'mistakes', 'investor'] },
  ),
  intent(
    'interview-mistakes',
    `
    what should I not ask in interviews
    what questions should I avoid asking customers
    common mistakes in customer interviews
    are my interview questions leading
    is this a bad question to ask customers
    how do I avoid bias in interviews
    what is the mom test
    check my interview questions
    fix my interview questions
    why are my interviews useless
    people only tell me what I want to hear in interviews
    what shouldn't I say to people in interviews
    `,
    { unless: ['job', 'internship'] },
  ),
  intent(
    'interview-debrief',
    `
    I just finished an interview, what do I do now
    how do I take notes after a customer interview
    I talked to a customer today
    debrief my interview
    what should I write down after an interview
    I did my first interview, here's what they said
    how do I record what customers told me
    we finished our customer call
    note template for interviews
    just had a customer convo
    first customer interview done today, here are my notes
    write up a conversation with a customer
    had my first interview, how do I log it
    `,
    { unless: ['job', 'internship', 'investor', 'all'] },
  ),
  intent(
    'synthesize-interviews',
    `
    I did 10 interviews, how do I make sense of them
    how do I analyze my customer interviews
    find patterns in my interviews
    synthesize my interview notes
    what do my interviews tell me
    how do I summarize all my customer interviews
    everyone told me something different
    how do I know if I have done enough interviews
    I finished all my interviews, what did I learn
    what does the data from my interviews mean
    I talked to fifteen people and got mixed answers
    when do I stop interviewing
    what do the interviews mean for what I build
    what does it mean for the product I'm building
    done with the interviews, what is the pattern
    `,
  ),
  intent(
    'fake-compliments',
    `
    people say they would buy it but nobody does
    everyone I interview says it sounds great
    they said they'd definitely use it
    how do I know if people are just being nice
    people are interested but not committing
    they told me to let them know when it launches
    strangers say they like it, does that mean anything
    how do I tell real interest from politeness
    customers said they love it
    everyone says cool idea but no one signs up
    lots of people said they're interested
    many are interested but none of them sign up
    say they love it but won't pay
    `,
    { unless: ['friends', 'family', 'mom', 'roommates'] },
  ),
  intent(
    'survey-or-talk',
    `
    should I send a survey
    can I just use a google form for customer discovery
    survey or interviews
    I made a survey, is that enough
    how do I write a good survey
    is a poll on instagram good research
    how many survey responses do I need
    what should I put in my survey
    I got 200 survey responses, what now
    can you make me a questionnaire
    poll people or talk to them
    is a google form ok as research
    poll or interviews first
    got survey answers, is that validation
    `,
  ),
  intent(
    'beachhead',
    `
    which customer segment should I start with
    what is a beachhead market
    my product is for everyone, who do I target first
    should I focus on one group of customers
    how do I narrow down my market
    which market should I go after first
    choose my first segment
    I have three customer groups, which one first
    is my target market too broad
    niche down or go broad
    students or professors first
    target market
    which segment first
    `,
  ),
  intent(
    'persona',
    `
    help me write a customer persona
    what is a persona
    make a user persona
    describe my ideal customer
    ideal customer profile
    how do I create a buyer persona
    build me a customer profile
    who is my ideal customer in detail
    do I need personas
    end user profile
    `,
  ),
  intent(
    'jobs-to-be-done',
    `
    what is jobs to be done
    what job is my product hired for
    why do people switch to a new product
    what are customers trying to get done
    how do I use jobs theory
    jtbd for my startup
    why do customers buy things like mine
    what progress are my customers trying to make
    understand why people buy
    what makes people switch from what they use now
    `,
    { unless: ['internship', 'resume'] },
  ),
  intent(
    'competitors',
    `
    who are my competitors
    how do I do a competitor analysis
    I don't have any competitors
    what makes me different from competitors
    how do I compare with the competition
    what do people use instead of my product
    how do I beat a bigger competitor
    competitive advantage
    competitive landscape
    what is my unfair advantage
    how do I compete with doordash
    why would they pick us over the competition
    substitutes and alternatives to my product
    how can we beat uber eats
    what do I do about a strong rival
    find out who my competitors are
    how are we different from the competition
    no competitors at all
    beat a bigger competitor
    `,
    { unless: ['pitch', 'student', 'center', 'told'] },
  ),
  intent(
    'market-size',
    `
    how big is my market
    how do I calculate TAM SAM SOM
    what's my total addressable market
    how do I estimate market size
    is my market big enough
    bottom up market sizing
    what number do I put for market size on my slide
    how many potential customers are there
    how do I find data on my market
    tam for my startup
    market sizing help
    `,
  ),
  intent(
    'no-replies',
    `
    nobody is replying to my emails
    no one answers my messages
    I emailed 20 people and got no response
    people ignore my linkedin messages
    nobody wants to talk to me for interviews
    I can't get anyone to do an interview
    how do I get people to respond
    I keep getting ghosted by people I want to interview
    I'm getting rejected by everyone I ask to talk
    zero replies so far
    everyone left me on read
    my cold emails are ignored
    my cold messages go unanswered
    everybody ignores my messages
    my cold messages get ignored
    messaged people and got zero replies
    `,
    { unless: ['deal', 'proposal', 'quote'] },
  ),
  intent(
    'networking',
    `
    how do I network as a student founder
    I'm bad at networking
    how do I talk to people at events
    I'm an introvert, how do I network
    how do I use linkedin to meet people
    what do I say when I meet someone at a conference
    how do I build relationships in my industry
    networking tips
    I'm going to a startup event tonight, what should I do
    how do I meet other founders
    how do I connect with alumni
    how do I follow up after meeting someone
    introduce myself at an event
    `,
  ),
  intent(
    'find-mentor',
    `
    how do I find a mentor
    I need a mentor
    who can mentor me
    can the Ain Center match me with a mentor
    how do I ask someone to be my mentor
    where do I find advisors for my startup
    should I have an advisory board
    I want to talk to an expert in my field
    can I talk to a real person
    how do I get an EIR
    connect me with a human advisor
    get me an advisor for this
    get an advisor for me
    `,
    { unless: ['prepare', 'session', 'tomorrow'] },
  ),
  intent(
    'mentor-prep',
    `
    how do I prepare for my EIR session
    I have a meeting with my mentor tomorrow
    what should I ask my mentor
    how do I get the most out of office hours
    prepare me for my mentor meeting
    what do I bring to a meeting with an entrepreneur in residence
    agenda for my mentor call
    I'm meeting my EIR this week
    help me write an update for my mentor
    what should i send my advisor before we meet
    what to bring to my EIR
    questions for my EIR
    `,
  ),
  intent(
    'find-cofounder',
    `
    how do I find a cofounder
    I need a cofounder
    where do I find a technical cofounder
    should I have a cofounder or go solo
    how do I know if someone is the right cofounder
    I'm a solo founder, is that bad
    how do I build a founding team
    looking for a partner for my startup
    should I start a company with my best friend
    what should I look for in a co founder
    need teammates for my startup
    need a business partner
    `,
    { unless: ['equity', 'split', 'shares', 'leaving', 'fight', 'fighting'] },
  ),
  intent(
    'team-conflict',
    `
    my cofounder and I are fighting
    I don't get along with my teammate
    my cofounder isn't doing any work
    how do I handle a conflict with my partner
    my team keeps arguing
    my cofounder wants to go in a different direction
    one person on my team is slacking
    how do I deal with a difficult cofounder
    my cofounder and I disagree about everything
    I want to kick out a team member
    my partner stopped showing up
    my teammate does nothing
    huge argument with my cofounder
    teammate never shows up and we fight
    `,
  ),
  // Validation
  intent(
    'will-anyone-pay',
    `
    will anyone actually pay for my idea
    will people pay for this
    how do I validate my idea
    how do I test demand
    how do I know there's demand
    would anyone buy this
    how do I prove people want this
    how do I know if people would spend money on it
    idea validation
    how can I tell if customers will pay before I build
    is there real demand for this
    would somebody pay for it
    how can I be certain people would buy
    would a single person pay money for this
    how do I make sure somebody will buy this
    be sure people will buy
    does that mean they would pay
    learn whether people want it
    find out if people want this
    `,
    { unless: ['friends', 'tuition'] },
  ),
  intent(
    'value-proposition',
    `
    what is my value proposition
    help me with the value proposition canvas
    how do I write a value prop
    why should customers choose us
    what value do I offer
    what are the pains and gains of my customers
    make my value proposition clearer
    what's in it for the customer
    what makes my offer valuable
    fill in a value proposition canvas
    unique value proposition
    `,
  ),
  intent(
    'positioning',
    `
    write a positioning statement
    how should I position my product
    how do I explain what category my product is in
    people don't understand what my product is
    what is positioning
    how do I position against the market leader
    people keep comparing us to the wrong thing
    messaging for my product
    what should my tagline be
    people are confused about what we do
    nobody understands what category we are
    confused about what our product is
    `,
  ),
  intent(
    'smallest-test',
    `
    what is an MVP
    what should my MVP be
    how do I build a minimum viable product
    what's the fastest way to test my idea
    what kind of test should I run
    how small can my first version be
    which type of mvp should I do
    how can I test this without spending much
    simplest version of my product
    what features should be in my first version
    how do I test my idea this week
    minimal product to learn something
    smallest thing I can make to test it
    `,
  ),
  intent(
    'build-first',
    `
    should I build the app first
    can I just start building
    I want to start coding the product
    let me just code it right now
    do I need an app
    when should I start building
    I've been building for two months
    should I build the whole product before showing people
    I'm almost done with my app, then I'll talk to customers
    do I need a website first
    should i make the app before i talk to anyone
    build first or validate first
    should I code it now or later
    code the app or wait
    build it before talking to customers
    is an app even needed
    `,
    { unless: ['deck', 'network', 'list'] },
  ),
  intent(
    'concierge-test',
    `
    what is a concierge test
    can I do it manually first
    should I do the service by hand for the first customers
    concierge mvp
    how do I run my idea manually
    do things that don't scale
    test it by doing it myself
    deliver it by hand before automating
    how do I fake it manually for five customers
    `,
  ),
  intent(
    'wizard-of-oz',
    `
    what is a wizard of oz test
    can I fake the backend
    wizard of oz mvp
    can I pretend it's automated while I do it
    test the product with me behind the scenes
    simulate the AI by hand
    fake the technology and do it behind the curtain
    can I test my ai product without building the ai
    is it ok to fake the feature
    `,
  ),
  intent(
    'landing-page',
    `
    how do I make a landing page
    what should go on my landing page
    write copy for my website
    landing page test
    is a waitlist a good test
    how do I test demand with a website
    review my landing page
    I have a landing page with signups, is that good
    what should my homepage say
    smoke test page
    should I make a waitlist
    what should the first screen of my site say
    words for my website's first screen
    `,
  ),
  intent(
    'pre-sale',
    `
    can I sell it before it exists
    how do I get preorders
    should I do a presale
    can I presell my product
    how do I take pre orders
    can I charge people before the product is ready
    selling before building
    how do I run a pre-sale
    is it ok to take money before I have the product
    get paid upfront
    kickstarter style preorder
    take deposits for my product
    take orders before it exists
    `,
  ),
  intent(
    'letter-of-intent',
    `
    what is a letter of intent
    how do I get an LOI
    write a letter of intent for a customer
    does a letter of intent count as proof
    template for a LOI
    a company is interested but can't pay yet
    how do I get a company to commit without paying
    non binding agreement to buy
    memorandum of understanding with a customer
    they want in but have no budget yet, what can they sign
    company wants it but has no budget this year
    `,
  ),
  intent(
    'prototype',
    `
    how do I make a prototype
    what kind of prototype do I need
    should I make mockups
    how do I test a prototype with users
    paper prototype or figma
    how good should my prototype be
    usability test
    wireframes for my app
    clickable prototype
    3d print a prototype
    show users a mockup
    `,
  ),
  intent(
    'experiment-design',
    `
    how do I design an experiment
    help me set up a test for my hypothesis
    what should my success criteria be
    how do I write a hypothesis
    what is a good pass or fail line
    how many people do I need for a test
    test card
    how do I test an assumption
    design an experiment for my startup
    what would prove me wrong
    what threshold should I set for my experiment
    which number means the test passed
    `,
  ),
  intent(
    'read-results',
    `
    my test failed, what does it mean
    how do I interpret my experiment results
    I got 4 signups out of 50, is that good
    are these results good
    the results are in, now what
    what do these numbers mean for my test
    only two people bought
    nobody bought it
    my experiment worked, what now
    is this conversion rate good
    we got some sales, is that enough
    we had six sales, is that number good
    we sold 5 out of 30, is that a good result
    our test results were mixed
    only a few paid, how do I read that result
    our test got 9 out of 30, is it good or bad
    the experiment flopped
    is that good ... now
    is that a good result
    `,
  ),
  intent(
    'pivot-or-persevere',
    `
    should I pivot
    should I change my idea
    how do I know when to pivot
    pivot or keep going
    is it time to change direction
    should we switch to a different customer
    my idea isn't working, should I try something else
    persevere or pivot
    when is it time to pivot
    thinking of changing the whole product
    `,
    { unless: ['decided', 'quit'] },
  ),
  intent(
    'after-a-pivot',
    `
    after our pivot, tell me what is different in the plan
    we pivoted, what do we do now
    what changes after the pivot
    we changed our customer, what's the new plan
    we decided to change direction, update my plan
    I pivoted, what stays the same
    now that we pivoted what should we test first
    our new plan after pivoting
    how do I tell my users we pivoted
    we switched to selling to restaurants, what changes now
    since the pivot, what do we do first
    `,
  ),
  intent(
    'patent-now-or-wait',
    `
    file a patent now
    do I need a patent
    when should I patent my invention
    how do I protect my invention
    provisional patent
    can I patent my idea
    how much does a patent cost
    should I publish my paper before filing a patent
    I'm presenting a poster, do I need to patent first
    can I pitch before I file a patent
    is my app patentable
    patent my idea before someone steals it
    file a provisional now or later
    talk about it without hurting the patent
    does showing it hurt the patent
    `,
    { referral: true, unless: ['leather'] },
  ),
  intent(
    'regulated-data',
    `
    can I collect health data from users
    do I need to be HIPAA compliant
    how do I handle private user data
    can I use student grades in my app
    can we get access to student records
    what about FERPA
    my app stores medical records
    do I need a privacy policy
    can I scrape personal data
    is it legal to record users
    do I need IRB approval to interview people
    my app collects personal information from minors
    user privacy and data protection rules
    legal to store patient information
    keeping patients' health info in an app
    `,
    { referral: true },
  ),
  intent(
    'medical-rules',
    `
    do I need FDA approval
    what FDA class is my device
    how do I get through clinical trials
    what is a 510k
    regulatory pathway for my device
    is my health app a medical device
    can I test my device on patients
    what regulations apply to my diagnostic
    how long does fda clearance take
    can I say my product treats a disease
    do I need a clinical study
    fda path for a health app
    `,
    { referral: true },
  ),
  intent(
    'pilot-agreement',
    `
    how do I set up a pilot
    a company wants to do a pilot with us
    what goes in a pilot agreement
    should my pilot be free or paid
    how much do I charge for a pilot
    how long should a pilot be
    write a pilot proposal
    proof of concept with a customer
    how do I turn a pilot into a contract
    terms for a pilot program
    a lab wants to try our product for a month
    free trial for a business customer
    `,
    { unless: ['airline', 'plane'] },
  ),
  intent(
    'hardware-first-units',
    `
    how do I manufacture my product
    I have a physical product, how do I make the first ones
    how do I find a manufacturer
    should I make a mold
    how do I make a small batch
    hardware startup, what first
    where do I get my product made
    how do I source suppliers
    cost to manufacture my gadget
    first production run
    supplier on alibaba
    who can produce a hundred units for me
    make fifty pieces of my device
    `,
  ),
  // Business model
  intent(
    'business-model-canvas',
    `
    help me fill out the business model canvas
    what is a business model canvas
    what goes in the key partners box
    how do I do a BMC
    what are the nine blocks
    explain the canvas
    what is my business model
    review my business model canvas
    customer segments and channels on the canvas
    how do I develop a business model
    `,
    { unless: ['submit', 'capstone', 'due', 'competition', 'value', 'lean'] },
  ),
  intent(
    'ain-canvas-capstone',
    `
    how do I submit my business model canvas
    module 1 capstone
    my canvas is due next week
    hand in my canvas for module one
    module 1 business model canvas
    what do I need for the module 1 capstone
    help with the business model canvas capstone
    final canvas for the Foundry
    BMC assignment for Ain
    is my canvas ready to hand in
    canvas capstone checklist
    finish module one
    `,
  ),
  intent(
    'service-or-product',
    `
    AI agents for office paperwork, sell them as a service or as consulting
    should I start as a service or a product
    consulting or software
    should I sell a service first and then build software
    agency or saas
    can I turn my consulting into a product
    should this be a service business or a tech company
    freelance or startup
    automate ERP processes for companies, service or product
    product or service for my ai idea
    productized service
    do i do consulting or both
    consultancy or a software product
    `,
  ),
  intent(
    'revenue-model',
    `
    how will my business make money
    what revenue model should I use
    subscription or one time payment
    how do I monetize my app
    how will my app make money
    should it be free with ads
    freemium or paid
    should I take a commission
    how do apps like mine make money
    what are my revenue streams
    ways to get paid
    how do I monetise this
    should I charge a fee per transaction
    subscription fee or a one-time fee
    `,
  ),
  intent(
    'pricing',
    `
    price my product
    what should I charge
    how much should I charge for this
    what price should I set
    how do I set prices
    is my price too high
    am I charging too little
    pricing strategy
    how do I know what my product is worth
    help me with pricing
    what would a fair price be
    how much shud i charge
    how much do I charge
    is my fee right
    what should the fee be
    price it
    `,
    { unless: ['ticket', 'patent', 'lawyer', 'valuation', 'testing'] },
  ),
  intent(
    'price-test',
    `
    how do I test my price
    how do I find out what people will pay
    should I raise my price
    how do I run a pricing experiment
    test two prices
    can I charge different prices to different people
    should I give a discount
    customers say it's too expensive
    everyone says yes to my price, is it too low
    how do I know if my price is right
    a/b test my pricing
    people think the price is too high
    do I raise the price, yes or no
    `,
  ),
  intent(
    'unit-economics',
    `
    what are unit economics
    help me with my unit economics
    how do I calculate profit per customer
    do I make money on each sale
    how do I calculate CAC and LTV
    what's my contribution margin
    what is customer acquisition cost
    is each order profitable
    how much do I keep per sale
    calculate my margins
    lifetime value of a customer
    cost per unit and profit
    am I losing money on every order
    profit left on one order
    `,
  ),
  intent(
    'break-even',
    `
    what's my break even point
    how many sales do I need to break even
    when will I be profitable
    how many do I have to sell to cover my costs
    calculate break-even
    breakeven analysis
    how much do I need to sell each month to survive
    fixed costs versus variable costs
    when do we stop losing money
    how many customers until we cover rent
    `,
  ),
  intent(
    'money-to-start',
    `
    money needed to get started
    how much does it cost to start
    what's my startup budget
    how much capital do I need
    what are my startup costs
    can I start with no money
    how much cash to launch this
    what do I need to spend money on first
    make a budget for my startup
    how much funding do I need to start
    is five hundred dollars enough to start
    what budget would I need
    budget to begin
    how much money will it take
    `,
  ),
  intent(
    'financial-forecast',
    `
    how do I make a financial forecast
    help me with financial projections
    build a financial model
    project my revenue for next year
    how do I forecast sales
    cash flow projection
    make a cash forecast
    what goes in a profit and loss
    investors want three year projections
    make a spreadsheet of my finances
    revenue projections for my startup
    `,
  ),
  intent(
    'bootstrapping',
    `
    should I bootstrap
    what is bootstrapping
    how do I fund this myself
    how do I start without investors
    grow without outside investors
    should I use my savings
    how can I grow without raising money
    can I use a credit card to fund my startup
    self funding my business
    how do I keep control of my company
    make do with little money
    pay for it out of my own pocket
    `,
  ),
  intent(
    'grants-angels-vc',
    `
    grants or angels or VC
    what kind of funding should I get
    grants or investors
    what's the difference between an angel and a VC
    how do I fund my startup
    what funding is right for me
    where can I get grants
    sbir grant
    am I ready for venture capital
    how does fundraising work
    funding options for students
    seed funding or grant
    how do I raise money
    grant or venture capital
    `,
    { unless: ['meeting', 'uncle', 'parents', 'family'] },
  ),
  intent(
    'friends-family-money',
    `
    my uncle wants to invest in my startup
    can my parents invest
    should I take money from friends and family
    my friend wants to give me money for shares
    how do I take investment from family
    should I do a crowdfunding campaign
    can I raise money on kickstarter or wefunder
    my dad will lend me money for the business
    a relative offered to put in money
    friends want to buy a piece of the company
    relative wants to put in money and asks for a percentage
    wants a percentage of the company for the money
    `,
    { referral: true },
  ),
  intent(
    'valuation',
    `
    no revenue, what is my company worth to an investor
    what is my startup worth
    value my company
    what valuation should I ask for
    how much is my company worth
    how do investors decide valuation
    what is a pre money valuation
    how much equity should I give an investor
    what percent of my company should I sell
    how do I come up with a valuation
    how much should I raise and at what valuation
    valuation cap
    `,
    { referral: true },
  ),
  intent(
    'term-sheet',
    `
    I got a term sheet, what do I do
    should I sign this term sheet
    explain this term sheet
    an investor sent me a SAFE
    what is a SAFE note
    what is a convertible note
    should I accept this investor's offer
    what does liquidation preference mean
    negotiate with an investor
    they offered money for part of my company, should I take it
    investor wants a board seat
    `,
    { referral: true },
  ),
  intent(
    'equity-split',
    `
    split equity
    how do we divide shares
    is 50/50 fair
    how much equity should my cofounder get
    how do I split ownership with my partner
    what is vesting
    should I give my friend equity
    how much equity for an early employee
    equity for advisors
    cofounder wants more equity
    how to split the company between three founders
    who gets how much of the company
    we never talked about who owns what
    who owns what between the two of us
    `,
    { referral: true },
  ),
  intent(
    'cofounder-agreement',
    `
    do we need a cofounder agreement
    who should be CEO
    how do we divide roles between founders
    what goes in a founders agreement
    how do we decide who does what
    what happens if my cofounder leaves
    my cofounder is leaving the company
    write a founder agreement
    roles and responsibilities for our team
    operating agreement between founders
    my cofounder graduated and left, who owns their part
    `,
    { referral: true },
  ),
  intent(
    'legal-structure',
    `
    should I form an LLC
    LLC or C corp
    when should I incorporate
    do I need to register my business
    what legal structure should I choose
    what is a DBA
    do I need a company to sell things
    how do I set up a company
    sole proprietorship or LLC
    incorporate in delaware
    legal designation for my business
    should I get an llc before I sell
    `,
    { referral: true },
  ),
  intent(
    'contracts-and-insurance',
    `
    do I need a contract with my customer
    can you write a contract for me
    do I need insurance
    what if someone gets hurt using my product
    am I liable if something goes wrong
    can I get sued
    terms and conditions for my app
    a customer wants me to sign their contract
    liability waiver
    someone is threatening to sue me
    is this contract ok to sign
    do I need a lawyer
    do I sign it
    should I sign this
    guarantee it is legal
    `,
    { referral: true },
  ),
  intent(
    'taxes',
    `
    do I have to pay taxes on my startup
    how do taxes work for my business
    do I need to collect sales tax
    do I need an EIN
    how do I file taxes for my side business
    can I deduct business expenses
    do I report income from selling to students
    tax forms for my startup
    irs self employment
    accounting and bookkeeping for my business
    `,
    { referral: true },
  ),
  intent(
    'permits-food',
    `
    do I need a permit to sell food on campus
    can I sell food from my dorm
    what license do I need to sell food
    am I allowed to sell on campus
    health permit for a food stand
    can I cook at home and sell it
    do I need a license for my business
    rules for selling food to students
    food truck permits
    university rules about selling things
    can I sell alcohol at my event
    `,
    { referral: true },
  ),
  // Commercialization
  intent(
    'first-ten-customers',
    `
    how do I get my first customers
    how do I get my first 10 customers
    how do I make my first sale
    I need paying customers
    how do I land my first client
    where do my first buyers come from
    how do I sell to my first customers
    get first ten paying customers
    nobody has bought yet, how do I get the first one
    how do I find clients
    my first sale
    go from a few customers to ten
    get from four customers to ten
    `,
    { unless: ['month', 'interview', 'talk', 'interviews'] },
  ),
  intent(
    'first-100-users',
    `
    first 100 users with no budget
    how do I get users with no money
    how do I get people to download my app
    how do I grow my user base
    how do I get students to use my app
    get my first hundred users
    I need more users
    how do I market on campus for free
    how do I spread the word about my app
    how do I get signups
    ways to get users cheaply
    how do i get more ppl on my app
    how do I reach a hundred people using the app
    more downloads without a budget
    reach a hundred users on the cheap
    `,
  ),
  intent(
    'channel-choice',
    `
    marketing channel to focus on
    how should I market my product
    should I use instagram or tiktok
    should I run ads
    what is the best way to reach customers
    where should I advertise
    which channel works best
    marketing plan for my startup
    should I do social media marketing
    how do I choose a marketing channel
    seo or ads or email
    how do I promote my business
    flyers or instagram
    tiktok or email for marketing
    `,
  ),
  intent(
    'cold-outreach',
    `
    write me a cold email
    help me write an outreach message
    how do I cold email someone
    draft an email to a potential customer
    linkedin message to a potential user
    how do I reach out to strangers
    write a message to a restaurant owner
    cold call script
    email template to ask for a meeting
    draft an outreach email
    dm template
    what do I say in a cold message
    `,
    { unless: ['ventures', 'iso', 'visa', 'investor', 'investors', 'reply', 'replying', 'response'] },
  ),
  intent(
    'sales-conversation',
    `
    how do I sell
    I have a sales call tomorrow
    how do I close a sale
    what do I say in a sales meeting
    how do I handle objections
    I'm bad at selling
    how do I ask for the sale
    sales pitch to a customer
    sales script
    how do I convince a customer to buy
    customer says they'll think about it
    prepare me for a sales call
    bad at selling, how do I close
    what to say on a sales call
    sales call on ... help
    `,
    { unless: ['tax', 'presale'] },
  ),
  intent(
    'stalled-deal',
    `
    a customer went quiet
    a customer stopped responding after my proposal
    my lead ghosted me
    they said they'd get back to me and didn't
    how do I follow up on a deal
    the deal is stuck
    prospect not answering after the demo
    how many times should I follow up with a lead
    they keep delaying the decision
    I sent a quote and heard nothing
    the buyer disappeared
    my client is ghosting me
    the lead went silent after the quote
    `,
  ),
  intent(
    'b2b-selling',
    `
    how do I sell to businesses
    how do I sell to a company
    who in the company do I talk to
    how do I find the decision maker
    b2b sales
    how do I sell to a hospital
    how do I sell to universities
    selling to enterprises
    long sales cycle
    who has the budget at a company
    procurement is blocking my deal
    how do I get a meeting with a big company
    sell software to restaurants
    `,
  ),
  intent(
    'marketplace',
    `
    how do I start a marketplace
    I have a two sided platform, which side first
    chicken and egg problem
    how do I get both buyers and sellers
    how do I get supply for my marketplace
    tutors and students on one platform
    uber for something
    cold start problem
    how do network effects work for my app
    my platform needs both sides
    airbnb for students
    drivers or riders first
    `,
  ),
  intent(
    'one-metric',
    `
    what metric should I track
    what numbers should I look at
    what is my north star metric
    which KPIs matter for my stage
    what should I measure
    how do I know if I'm making progress
    key metrics for my startup
    one metric that matters
    what analytics do I need
    what is a good metric for an early startup
    vanity metrics
    which kpi do we follow
    which numbers matter for us
    `,
  ),
  intent(
    'launch',
    `
    how do I launch
    when should I launch
    help me plan my launch
    am I ready to launch
    launch strategy
    what do I do on launch day
    product hunt launch
    soft launch or big launch
    how do I do a campus launch
    launch checklist
    going live next week
    we launch next week
    `,
    { unless: ['cash', 'money'] },
  ),
  intent(
    'elevator-pitch',
    `
    help me write an elevator pitch
    30 second pitch
    how do I describe my startup in one sentence
    short pitch for my idea
    one liner for my company
    how do I introduce my startup quickly
    one minute pitch
    what do I say when people ask what I do
    quick intro pitch
    pitch me in a sentence
    how do I open when I stand up to pitch
    opening line of my pitch
    `,
  ),
  intent(
    'pitch-deck',
    `
    help me make a pitch deck
    what slides do I need in my deck
    how many slides should a pitch have
    review my pitch deck
    order of slides for my pitch
    what goes on the problem slide
    how do I make slides for investors
    pitch deck template
    create a deck
    fix my deck
    outline for my pitch slides
    `,
    { unless: ['team', 'teams', 'student'] },
  ),
  intent(
    'pitch-competition',
    `
    I have a pitch competition, help me prepare
    how do I prepare for a pitch competition
    I'm pitching next week
    what do judges look for
    pitch contest in two weeks
    how do I win a business plan competition
    prepare me for the Ain business model competition
    practice for the competition
    should I enter a startup competition
    timeline for pitch competition prep
    my pitch is on friday
    forbes pitch competition
    help me get ready to pitch to judges
    pitching at a competition, help me prepare slides and a live pitch
    live pitch in front of judges
    prepare a pitch
    `,
  ),
  intent(
    'demo',
    `
    how do I do a product demo
    prepare a demo
    demo day
    I have to demo my product
    what should I show in my demo
    what if my demo breaks
    demo script
    live demo or video
    how long should my demo be
    show my product to customers on a call
    `,
  ),
  intent(
    'qa-prep',
    `
    what questions will judges ask
    help me prepare for Q&A
    practice hard questions with me
    what will investors ask me
    how do I answer tough questions
    questions after the pitch
    grill me on my startup
    what if I don't know the answer to a judge
    mock q and a
    prepare answers for investor questions
    `,
  ),
  intent(
    'investor-meeting',
    `
    what investors look for when we first meet
    I have a meeting with an investor
    how do I prepare for a VC meeting
    my first VC meeting is this week
    what should I say to an angel investor
    first call with an investor
    what do VCs want to see
    meeting an angel next week
    how do investors decide
    what to bring to an investor meeting
    what impresses investors
    `,
    { unless: ['valuation'] },
  ),
  intent(
    'find-investors',
    `
    how do I find investors
    where do I find angel investors
    can you introduce me to investors
    how do I get a meeting with a VC
    list of investors for my startup
    how do I reach out to investors
    cold email an investor
    who invests in student startups
    get warm intros to investors
    email to a vc
    investor outreach
    list of investors
    need names of VCs
    `,
  ),
  intent(
    'ain-pitch-capstone',
    `
    module 2 capstone
    how do I submit my pitch
    the perfect pitch assignment
    my pitch capstone is due
    what do I need for the module 2 pitch
    record my pitch for the Foundry
    pitch capstone checklist
    help with my Foundry pitch
    finish module two
    pitch video for Ain
    `,
  ),
  // Growth
  intent(
    'retention',
    `
    users try it once and never come back
    how do I keep customers
    why are my users leaving
    my retention is bad
    how do I reduce churn
    people sign up but don't use it
    customers don't reorder
    how do I get repeat customers
    users drop off after a week
    people stopped using my app
    no one comes back
    engagement is going down
    `,
  ),
  intent(
    'scaling-readiness',
    `
    am I ready to scale
    how do I scale my business
    when should I grow faster
    how do I grow my company
    we have too many orders, what do we do
    how do I know I have product market fit
    do I have product market fit
    how do I systemize my business
    I can't keep up with demand
    ready to expand operations
    how do I grow without doing everything myself
    `,
    { unless: ['users'] },
  ),
  intent(
    'hiring',
    `
    when should I hire someone
    how do I hire my first employee
    should I hire an intern
    how do I find good people to hire
    contractor or employee
    how do I pay the people who work for me
    hire a salesperson
    write a job description
    can I have unpaid interns
    how do I interview someone for my startup
    I need to hire help
    `,
    { unless: ['developer', 'agency', 'app'] },
  ),
  intent(
    'second-group',
    `
    should I expand to another campus
    when do I enter a new market
    how do I expand to a second customer group
    expand to other universities
    should I add a new customer segment
    new city or stay here
    what market should we go into next
    should I launch a second product
    going international
    open in another school
    second campus or stay on this one
    next campus
    second campus
    `,
  ),
  intent(
    'runway',
    `
    how long will my money last
    what's my runway
    we're running out of money
    what is my burn rate
    how many months of cash do we have
    we have no money left
    I can't pay my bills this month
    cash is low
    how do I manage cash flow
    customers owe me money
    almost out of cash
    `,
  ),
  intent(
    'raise-or-grow',
    `
    should I raise money now or grow on revenue
    should we raise a seed round
    is it time to raise
    raise money or stay independent
    when should I raise a round
    do we need investors to grow
    take investment or grow slowly
    should I give up equity to grow faster
    raise now or later
    should we fundraise this year
    should we raise money
    `,
  ),
  intent(
    'ain-plan-capstone',
    `
    help me write a business plan
    module 3 capstone
    what goes in a business plan
    business plan template
    my business plan is due
    how long should a business plan be
    do I need a business plan
    business plan capstone
    executive summary
    final plan for the Foundry
    write the business plan for Ain
    `,
    { unless: ['competition'] },
  ),
  // Transition
  intent(
    'leaving-ain',
    `
    ready to leave the Ain Center
    when should I leave the Ain Center
    am I ready to graduate from the program
    what comes after the Foundry
    done with the Foundry, where next
    where do I go after Ain
    I finished all three modules, what now
    I finished the Foundry program
    have I outgrown the Ain Center
    how do I know I'm ready to move on from the program
    exit the program
    ready to leave the incubator
    `,
  ),
  intent(
    'next-home',
    `
    should I apply to an accelerator
    incubator or accelerator
    how do I get into y combinator
    which accelerator should I join
    what is an incubator
    should I join techstars
    apply to an incubator
    are accelerators worth the equity
    where can I get office space for my startup
    accelerator application
    `,
  ),
  intent(
    'after-graduation',
    `
    what happens to my startup when I graduate
    I'm graduating, should I keep the startup
    how do I keep going after graduation
    my team is graduating
    going full time after I graduate
    what do we do with the company after college
    I graduate in may and don't know about the startup
    handing over my startup to someone else
    pass the venture to younger students
    moving away after graduation but want to keep it going
    who takes over when I graduate
    `,
  ),
  intent(
    'quit-or-continue',
    `
    should I quit my startup
    should I shut down my company
    how do I know when to give up
    I want to stop working on this startup
    is it time to let it go
    how do I close my business
    shut it down or keep trying
    pause the startup
    give up on my idea
    how do I wind down
    thinking about quitting the venture
    keep going with this or stop
    I should just stop the venture
    carry on or quit
    `,
    { unless: ['job', 'same', 'already'] },
  ),
  intent(
    'student-to-mentor',
    `
    how do I become a mentor for other students
    I want to give back to the Foundry
    join the Foundry alumni network
    can I mentor new founders
    how do I help other student founders
    stay involved with the Ain Center as an alum
    become a Foundry mentor
    alumni network for founders
    I'd like to coach younger founders
    I'm an alum and would love to mentor founders
    now that I'm an alumnus I'd like to help students
    `,
    { unless: ['find', 'need'] },
  ),
];
