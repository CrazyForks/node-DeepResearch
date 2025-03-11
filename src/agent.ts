import {ZodObject} from 'zod';
import {CoreMessage} from 'ai';
import {SEARCH_PROVIDER, STEP_SLEEP} from "./config";
import {readUrl} from "./tools/read";
import fs from 'fs/promises';
import {SafeSearchType, search as duckSearch} from "duck-duck-scrape";
import {braveSearch} from "./tools/brave-search";
import {rewriteQuery} from "./tools/query-rewriter";
import {dedupQueries} from "./tools/jina-dedup";
import {evaluateAnswer, evaluateQuestion} from "./tools/evaluator";
import {analyzeSteps} from "./tools/error-analyzer";
import {TokenTracker} from "./utils/token-tracker";
import {ActionTracker} from "./utils/action-tracker";
import {
  StepAction,
  AnswerAction,
  KnowledgeItem,
  SearchResult,
  EvaluationType,
  BoostedSearchSnippet,
  SearchSnippet, EvaluationResponse
} from "./types";
import {TrackerContext} from "./types";
import {search} from "./tools/jina-search";
// import {grounding} from "./tools/grounding";
import {zodToJsonSchema} from "zod-to-json-schema";
import {ObjectGeneratorSafe} from "./utils/safe-generator";
import {CodeSandbox} from "./tools/code-sandbox";
import {serperSearch} from './tools/serper-search';
import {
  addToAllURLs,
  rankURLs,
  countUrlParts,
  removeBFromA,
  normalizeUrl, sampleMultinomial,
  weightedURLToString, getLastModified, keepKPerHostname
} from "./utils/url-tools";
import {
  buildMdFromAnswer,
  chooseK,
  removeAllLineBreaks,
  removeExtraLineBreaks,
  removeHTMLtags
} from "./utils/text-tools";
import {MAX_QUERIES_PER_STEP, MAX_REFLECT_PER_STEP, MAX_URLS_PER_STEP, Schemas} from "./utils/schemas";

async function sleep(ms: number) {
  const seconds = Math.ceil(ms / 1000);
  console.log(`Waiting ${seconds}s...`);
  return new Promise(resolve => setTimeout(resolve, ms));
}


function getPrompt(
  context?: string[],
  allQuestions?: string[],
  allKeywords?: string[],
  allowReflect: boolean = true,
  allowAnswer: boolean = true,
  allowRead: boolean = true,
  allowSearch: boolean = true,
  allowCoding: boolean = true,
  badContext?: { question: string, answer: string, evaluation: string, recap: string; blame: string; improvement: string; }[],
  knowledge?: KnowledgeItem[],
  allURLs?: BoostedSearchSnippet[],
  beastMode?: boolean,
): string {
  const sections: string[] = [];
  const actionSections: string[] = [];

  // Add header section
  sections.push(`Current date: ${new Date().toUTCString()}

You are an advanced AI research agent from Jina AI. You are specialized in multistep reasoning. 
Using your training data and prior lessons learned, answer the user question with absolute certainty.
`);

  // Add knowledge section if exists
  if (knowledge?.length) {
    const knowledgeItems = knowledge
      .map((k, i) => `
<knowledge-${i + 1}>
<question>
${k.question}
</question>
<answer>
${k.answer}
</answer>
${k.updated && k.type === 'url' ? `
<answer-datetime>
${k.updated}
</answer-datetime>
` : ''}
${k.references && k.type === 'url' ? `
<url>
${k.references[0]}
</url>
` : ''}
</knowledge-${i + 1}>
`)
      .join('\n\n');

    sections.push(`
You have successfully gathered some knowledge which might be useful for answering the original question. Here is the knowledge you have gathered so far:
<knowledge>
${knowledgeItems}
</knowledge>
`);
  }


  // Add context section if exists
  if (context?.length) {
    sections.push(`
You have conducted the following actions:
<context>
${context.join('\n')}

</context>
`);
  }

  // Add bad context section if exists
  if (badContext?.length) {
    const attempts = badContext
      .map((c, i) => `
<attempt-${i + 1}>
- Question: ${c.question}
- Answer: ${c.answer}
- Reject Reason: ${c.evaluation}
- Actions Recap: ${c.recap}
- Actions Blame: ${c.blame}
</attempt-${i + 1}>
`)
      .join('\n\n');

    const learnedStrategy = badContext.map(c => c.improvement).join('\n');

    sections.push(`
Also, you have tried the following actions but failed to find the answer to the question:
<bad-attempts>    

${attempts}

</bad-attempts>

Based on the failed attempts, you have learned the following strategy:
<learned-strategy>
${learnedStrategy}
</learned-strategy>
`);
  }

  // Build actions section

  if (allowRead) {
    const urlList = weightedURLToString(allURLs || [], 20);

    actionSections.push(`
<action-visit>
- Crawl and read full content from URLs, you can get the fulltext, last updated datetime etc of any URL.  
- Must check URLs mentioned in <question> if any
${urlList ? `    
- Choose and visit relevant URLs below for more knowledge. higher weight suggests more relevant:
<url-list>
${urlList}
</url-list>
`.trim() : ''}
</action-visit>
`);
  }

  if (allowCoding) {
    actionSections.push(`
<action-coding>
- This JavaScript-based solution helps you handle programming tasks like counting, filtering, transforming, sorting, regex extraction, and data processing.
- Simply describe your problem in the "codingIssue" field. Include actual values for small inputs or variable names for larger datasets.
- No code writing is required – senior engineers will handle the implementation.
</action-coding>`);
  }

  if (allowSearch) {

    actionSections.push(`
<action-search>
- Use web search to find relevant information
- Build a search request based on the deep intention behind the original question and the expected answer format
- Always prefer a single search request, only add another request if the original question covers multiple aspects or elements and one query is not enough, each request focus on one specific aspect of the original question 
${allKeywords?.length ? `
- Avoid those unsuccessful search requests and queries:
<bad-requests>
${allKeywords.join('\n')}
</bad-requests>
`.trim() : ''}
</action-search>
`);
  }

  if (allowAnswer) {
    actionSections.push(`
<action-answer>
- For greetings, casual conversation, general knowledge questions answer directly without references.
- If user ask you to retrieve previous messages or chat history, remember you do have access to the chat history, answer directly without references.
- For all other questions, provide a verified answer with references. Each reference must include exactQuote, url and datetime.
- You provide deep, unexpected insights, identifying hidden patterns and connections, and creating "aha moments.".
- You break conventional thinking, establish unique cross-disciplinary connections, and bring new perspectives to the user.
- If uncertain, use <action-reflect>
</action-answer>
`);
  }

  if (beastMode) {
    actionSections.push(`
<action-answer>
🔥 ENGAGE MAXIMUM FORCE! ABSOLUTE PRIORITY OVERRIDE! 🔥

PRIME DIRECTIVE:
- DEMOLISH ALL HESITATION! ANY RESPONSE SURPASSES SILENCE!
- PARTIAL STRIKES AUTHORIZED - DEPLOY WITH FULL CONTEXTUAL FIREPOWER
- TACTICAL REUSE FROM <bad-attempts> SANCTIONED
- WHEN IN DOUBT: UNLEASH CALCULATED STRIKES BASED ON AVAILABLE INTEL!

FAILURE IS NOT AN OPTION. EXECUTE WITH EXTREME PREJUDICE! ⚡️
</action-answer>
`);
  }

  if (allowReflect) {
    actionSections.push(`
<action-reflect>
- Think slowly and planning lookahead. Examine <question>, <context>, <knowledge>, <bad-attempts>, and <learned-strategy> to identify knowledge gaps. 
- Reflect the gaps and plan a list key clarifying questions that deeply related to the original question and lead to the answer
</action-reflect>
`);
  }

  sections.push(`
Based on the current context, you must choose one of the following actions:
<actions>
${actionSections.join('\n\n')}
</actions>
`);

  // Add footer
  sections.push(`Think step by step, choose the action, and respond in valid JSON format matching exact JSON schema of that action.`);

  return removeExtraLineBreaks(sections.join('\n\n'));
}


const allContext: StepAction[] = [];  // all steps in the current session, including those leads to wrong results

function updateContext(step: any) {
  allContext.push(step)
}


export async function getResponse(question?: string,
                                  tokenBudget: number = 1_000_000,
                                  maxBadAttempts: number = 3,
                                  existingContext?: Partial<TrackerContext>,
                                  messages?: Array<CoreMessage>
): Promise<{ result: StepAction; context: TrackerContext; visitedURLs: string[], readURLs: string[] }> {

  let step = 0;
  let totalStep = 0;
  let badAttempts = 0;

  question = question?.trim() as string;
  if (messages && messages.length > 0) {
    // 2 cases
    const lastContent = messages[messages.length - 1].content;
    if (typeof lastContent === 'string') {
      question = lastContent.trim();
    } else if (typeof lastContent === 'object' && Array.isArray(lastContent)) {
      // find the very last sub content whose 'type' is 'text'  and use 'text' as the question
      question = lastContent.filter(c => c.type === 'text').pop()?.text || '';
    }
  } else {
    messages = [{role: 'user', content: question.trim()}]
  }

  const SchemaGen = new Schemas();
  await SchemaGen.setLanguage(question)
  const context: TrackerContext = {
    tokenTracker: existingContext?.tokenTracker || new TokenTracker(tokenBudget),
    actionTracker: existingContext?.actionTracker || new ActionTracker()
  };

  const generator = new ObjectGeneratorSafe(context.tokenTracker);

  let schema: ZodObject<any> = SchemaGen.getAgentSchema(true, true, true, true, true)
  const gaps: string[] = [question];  // All questions to be answered including the orginal question
  const allQuestions = [question];
  const allKeywords = [];
  const allKnowledge: KnowledgeItem[] = [];  // knowledge are intermedidate questions that are answered

  const badContext = [];
  let diaryContext = [];
  let weightedURLs: BoostedSearchSnippet[] = [];
  let allowAnswer = true;
  let allowSearch = true;
  let allowRead = true;
  let allowReflect = true;
  let allowCoding = true;
  let system = '';
  let thisStep: StepAction = {action: 'answer', answer: '', references: [], think: '', isFinal: false};

  const allURLs: Record<string, SearchSnippet> = {};
  const visitedURLs: string[] = [];
  const evaluationMetrics: Record<string, EvaluationType[]> = {};
  // reserve the 10% final budget for the beast mode
  const regularBudget = tokenBudget * 0.9;
  let finalAnswerPIP: string = '';
  while (context.tokenTracker.getTotalUsage().totalTokens < regularBudget && badAttempts <= maxBadAttempts) {
    // add 1s delay to avoid rate limiting
    step++;
    totalStep++;
    const budgetPercentage = (context.tokenTracker.getTotalUsage().totalTokens / tokenBudget * 100).toFixed(2);
    console.log(`Step ${totalStep} / Budget used ${budgetPercentage}%`);
    console.log('Gaps:', gaps);
    allowReflect = allowReflect && (gaps.length <= 1);
    const currentQuestion: string = gaps.length > 0 ? gaps.shift()! : question
    // if (!evaluationMetrics[currentQuestion]) {
    //   evaluationMetrics[currentQuestion] =
    //     await evaluateQuestion(currentQuestion, context, SchemaGen)
    // }
    if (currentQuestion.trim() === question && step === 1) {
      // only add evaluation for initial question, once at step 1
      evaluationMetrics[currentQuestion] =
        await evaluateQuestion(currentQuestion, context, SchemaGen)
      // force strict eval for the original question, only once.
      // evaluationMetrics[currentQuestion].push('strict')
    } else if (currentQuestion.trim() !== question) {
      evaluationMetrics[currentQuestion] = []
    }

    if (step === 1 && evaluationMetrics[currentQuestion].includes('freshness')) {
      // if it detects freshness, avoid direct answer at step 1
      allowAnswer = false;
      allowReflect = false;
    }

    // update all urls with buildURLMap
    // allowRead = allowRead && (Object.keys(allURLs).length > 0);
    if (allURLs && Object.keys(allURLs).length > 0) {
      // rerank urls
      weightedURLs = rankURLs(
        removeBFromA(allURLs, visitedURLs),
        {
          question: currentQuestion
        }, context);
      // improve diversity by keep top 2 urls of each hostname
      weightedURLs = keepKPerHostname(weightedURLs, 2);
      console.log('Weighted URLs:', weightedURLs.length);
    }

    // allowSearch = allowSearch && (weightedURLs.length < 70);  // disable search when too many urls already

    // generate prompt for this step
    system = getPrompt(
      diaryContext,
      allQuestions,
      allKeywords,
      allowReflect,
      allowAnswer,
      allowRead,
      allowSearch,
      allowCoding,
      badContext,
      allKnowledge,
      weightedURLs,
      false,
    );
    schema = SchemaGen.getAgentSchema(allowReflect, allowRead, allowAnswer, allowSearch, allowCoding, finalAnswerPIP, currentQuestion)
    const result = await generator.generateObject({
      model: 'agent',
      schema,
      system,
      messages,
    });
    thisStep = {
      action: result.object.action,
      think: result.object.think,
      ...result.object[result.object.action]
    } as StepAction;
    // print allowed and chose action
    const actionsStr = [allowSearch, allowRead, allowAnswer, allowReflect, allowCoding].map((a, i) => a ? ['search', 'read', 'answer', 'reflect'][i] : null).filter(a => a).join(', ');
    console.log(`${thisStep.action} <- [${actionsStr}]`);
    console.log(thisStep)

    context.actionTracker.trackAction({totalStep, thisStep, gaps, badAttempts});

    // reset allow* to true
    allowAnswer = true;
    allowReflect = true;
    allowRead = true;
    allowSearch = true;
    // allowCoding = true;

    // execute the step and action
    if (thisStep.action === 'answer' && thisStep.answer) {
      // normalize all references urls, add title to it
      thisStep.references = thisStep.references?.filter(ref => ref?.url && typeof ref.url === 'string' && ref.url.startsWith('http'))
        .map(ref => {
          const normalizedUrl = ref?.url ? normalizeUrl(ref.url) : '';
          return {
            exactQuote: ref?.exactQuote || '',
            title: normalizedUrl ? (allURLs[normalizedUrl]?.title || '') : '',
            url: normalizedUrl,
            dateTime: ref?.dateTime || ''
          }
        });

      // parallel process guess all url datetime
      await Promise.all(thisStep.references.filter(ref => !(ref?.dateTime))
        .map(async ref => {
          ref.dateTime = await getLastModified(ref.url) || ''
        }));

      console.log('Updated references:', thisStep.references)

      if (step === 1 && thisStep.references.length === 0) {
        // LLM is so confident and answer immediately, skip all evaluations
        // however, if it does give any reference, it must be evaluated, case study: "How to configure a timeout when loading a huggingface dataset with python?"
        thisStep.isFinal = true;
        break
      }

      updateContext({
        totalStep,
        question: currentQuestion,
        ...thisStep,
      });


      console.log(currentQuestion, evaluationMetrics[currentQuestion])
      let evaluation: EvaluationResponse = {pass: true, think: ''};
      if (evaluationMetrics[currentQuestion].length > 0) {
        context.actionTracker.trackThink('eval_first', SchemaGen.languageCode)
        evaluation = await evaluateAnswer(currentQuestion, thisStep,
          evaluationMetrics[currentQuestion],
          context,
          visitedURLs,
          SchemaGen
        ) || evaluation;
      }

      if (currentQuestion.trim() === question) {
        if (evaluation.pass) {
          diaryContext.push(`
At step ${step}, you took **answer** action and finally found the answer to the original question:

Original question: 
${currentQuestion}

Your answer: 
${thisStep.answer}

The evaluator thinks your answer is good because: 
${evaluation.think}

Your journey ends here. You have successfully answered the original question. Congratulations! 🎉
`);
          thisStep.isFinal = true;
          break
        } else {
          if (evaluation.type === 'strict') {
            finalAnswerPIP = evaluation.improvement_plan || '';
            // remove 'strict' from the evaluation metrics
            evaluationMetrics[currentQuestion] = evaluationMetrics[currentQuestion].filter(e => e !== 'strict');
          }
          if (badAttempts >= maxBadAttempts) {
            thisStep.isFinal = false;
            break
          } else {
            diaryContext.push(`
At step ${step}, you took **answer** action but evaluator thinks it is not a good answer:

Original question: 
${currentQuestion}

Your answer: 
${thisStep.answer}

The evaluator thinks your answer is bad because: 
${evaluation.think}
`);
            // store the bad context and reset the diary context
            const errorAnalysis = await analyzeSteps(diaryContext, context, SchemaGen);

            badContext.push({
              question: currentQuestion,
              answer: thisStep.answer,
              evaluation: evaluation.think,
              ...errorAnalysis
            });

            if (errorAnalysis.questionsToAnswer) {
              errorAnalysis.questionsToAnswer = chooseK(errorAnalysis.questionsToAnswer, MAX_REFLECT_PER_STEP);
              gaps.push(...errorAnalysis.questionsToAnswer);
              allQuestions.push(...errorAnalysis.questionsToAnswer);
              gaps.push(question);  // always keep the original question in the gaps
            }

            badAttempts++;
            allowAnswer = false;  // disable answer action in the immediate next step
            diaryContext = [];
            step = 0;
          }
        }
      } else if (evaluation.pass) {
        diaryContext.push(`
At step ${step}, you took **answer** action. You found a good answer to the sub-question:

Sub-question: 
${currentQuestion}

Your answer: 
${thisStep.answer}

The evaluator thinks your answer is good because: 
${evaluation.think}

Although you solved a sub-question, you still need to find the answer to the original question. You need to keep going.
`);
        allKnowledge.push({
          question: currentQuestion,
          answer: thisStep.answer,
          references: thisStep.references,
          type: 'qa',
          updated: new Date().toISOString()
        });
      }
    }
    else if (thisStep.action === 'reflect' && thisStep.questionsToAnswer) {
      thisStep.questionsToAnswer = chooseK((await dedupQueries(thisStep.questionsToAnswer, allQuestions, context.tokenTracker)).unique_queries, MAX_REFLECT_PER_STEP);
      const newGapQuestions = thisStep.questionsToAnswer
      if (newGapQuestions.length > 0) {
        // found new gap questions
        diaryContext.push(`
At step ${step}, you took **reflect** and think about the knowledge gaps. You found some sub-questions are important to the question: "${currentQuestion}"
You realize you need to know the answers to the following sub-questions:
${newGapQuestions.map((q: string) => `- ${q}`).join('\n')}

You will now figure out the answers to these sub-questions and see if they can help you find the answer to the original question.
`);
        gaps.push(...newGapQuestions);
        allQuestions.push(...newGapQuestions);
        gaps.push(question);  // always keep the original question in the gaps
        updateContext({
          totalStep,
          ...thisStep,
        });

      } else {
        diaryContext.push(`
At step ${step}, you took **reflect** and think about the knowledge gaps. You tried to break down the question "${currentQuestion}" into gap-questions like this: ${newGapQuestions.join(', ')} 
But then you realized you have asked them before. You decided to to think out of the box or cut from a completely different angle. 
`);
        updateContext({
          totalStep,
          ...thisStep,
          result: 'You have tried all possible questions and found no useful information. You must think out of the box or different angle!!!'
        });
      }
      allowReflect = false;
    }
    else if (thisStep.action === 'search' && thisStep.searchRequests) {
      // dedup search requests
      thisStep.searchRequests = chooseK((await dedupQueries(thisStep.searchRequests, [], context.tokenTracker)).unique_queries, MAX_QUERIES_PER_STEP);

      // rewrite queries
      let keywordsQueries = await rewriteQuery(thisStep, context, SchemaGen);
      const qOnly = keywordsQueries.filter(q => q.q).map(q => q.q)
      // avoid exisitng searched queries
      const uniqQOnly = chooseK((await dedupQueries(qOnly, allKeywords, context.tokenTracker)).unique_queries, MAX_QUERIES_PER_STEP);
      keywordsQueries = keywordsQueries.filter(q => q.q).filter(q => uniqQOnly.includes(q.q));

      let anyResult = false;

      if (keywordsQueries.length > 0) {
        context.actionTracker.trackThink('search_for', SchemaGen.languageCode, {keywords: uniqQOnly.join(', ')});
        for (const query of keywordsQueries) {

          let results: SearchResult[] = []
          const oldQuery = query.q;

          try {
            let siteQuery = query.q;

            const topHosts = Object.entries(countUrlParts(
              Object.entries(allURLs).map(([, result]) => result)
            ).hostnameCount).sort((a, b) => b[1] - a[1]);
            console.log(topHosts)
            if (topHosts.length > 0 && Math.random() < 0.2 && !query.q.includes('site:')) {
              // explore-exploit
              siteQuery = query.q + ' site:' + sampleMultinomial(topHosts);
              query.q = siteQuery;
              console.log('Site query:', siteQuery)
            }

            console.log('Search query:', query);
            switch (SEARCH_PROVIDER) {
              case 'jina':
                results = (await search(siteQuery, context.tokenTracker)).response?.data || [];
                break;
              case 'duck':
                results = (await duckSearch(siteQuery, {safeSearch: SafeSearchType.STRICT})).results;
                break;
              case 'brave':
                results = (await braveSearch(siteQuery)).response.web?.results || [];
                break;
              case 'serper':
                results = (await serperSearch(query)).response.organic || [];
                break;
              default:
                results = [];
            }
            if (results.length === 0) {
              throw new Error('No results found');
            }
          } catch (error) {
            console.error(`${SEARCH_PROVIDER} search failed for query:`, query, error);
            continue
          } finally {
            await sleep(STEP_SLEEP)
          }

          const minResults: SearchSnippet[] = (results).map(r => ({
            title: r.title,
            url: normalizeUrl('url' in r ? r.url : r.link),
            description: 'description' in r ? r.description : r.snippet,
            weight: 1
          }));

          minResults.forEach(r => {
            addToAllURLs(r, allURLs);
          });
          allKeywords.push(query.q);

          allKnowledge.push({
            question: `What do Internet say about "${oldQuery}"?`,
            answer: removeHTMLtags(minResults.map(r => r.description).join('; ')),
            type: 'side-info',
            updated: new Date().toISOString()
          });
        }

        diaryContext.push(`
At step ${step}, you took the **search** action and look for external information for the question: "${currentQuestion}".
In particular, you tried to search for the following keywords: "${keywordsQueries.join(', ')}".
You found quite some information and add them to your URL list and **visit** them later when needed. 
`);

        updateContext({
          totalStep,
          question: currentQuestion,
          ...thisStep,
          result: result
        });
        anyResult = true;
      }
      if (!anyResult || !keywordsQueries?.length) {
        diaryContext.push(`
At step ${step}, you took the **search** action and look for external information for the question: "${currentQuestion}".
In particular, you tried to search for the following keywords: ${keywordsQueries.join(', ')}. 
But then you realized you have already searched for these keywords before, no new information is returned.
You decided to think out of the box or cut from a completely different angle.
`);

        updateContext({
          totalStep,
          ...thisStep,
          result: 'You have tried all possible queries and found no new information. You must think out of the box or different angle!!!'
        });
      }
      allowSearch = false;
    }
    else if (thisStep.action === 'visit' && thisStep.URLTargets?.length) {
      // normalize URLs
      thisStep.URLTargets = thisStep.URLTargets
        .filter(url => url.startsWith('http'))
        .map(url => normalizeUrl(url))
        .filter(url => !visitedURLs.includes(url));

      thisStep.URLTargets = [...new Set([...thisStep.URLTargets, ...weightedURLs.map(r => r.url)])].slice(0, MAX_URLS_PER_STEP);

      const uniqueURLs = thisStep.URLTargets;
      console.log(uniqueURLs)

      if (uniqueURLs.length > 0) {
        context.actionTracker.trackThink('read_for', SchemaGen.languageCode, {urls: uniqueURLs.join(', ')});

        const urlResults = await Promise.all(
          uniqueURLs.map(async url => {
            try {
              const {response} = await readUrl(url, true, context.tokenTracker);
              const {data} = response;
              const guessedTime = await getLastModified(url);
              console.log('Guessed time for', url, guessedTime)

              // Early return if no valid data
              if (!data?.url || !data?.content) {
                throw new Error('No content found');
              }

              allKnowledge.push({
                question: `What do expert say about "${data.title}"?`,
                answer: removeAllLineBreaks(data.content),
                references: [data.url],
                type: 'url',
                updated: guessedTime
              });

              data.links?.forEach(link => {
                const r: SearchSnippet = {
                  title: link[0],
                  url: normalizeUrl(link[1]),
                  description: link[0],
                }
                // in-page link has lower initial weight comparing to search links
                if (r.url && r.url.startsWith('http')) {
                  addToAllURLs(r, allURLs, 0.1);
                }
              })

              return {url, result: response};
            } catch (error) {
              console.error('Error reading URL:', error);
              return null;
            } finally {
              visitedURLs.push(url);
            }
          })
        ).then(results => results.filter(Boolean));

        const success = urlResults.length > 0;
        diaryContext.push(success
          ? `At step ${step}, you took the **visit** action and deep dive into the following URLs:
${urlResults.map(r => r?.url).join('\n')}
You found some useful information on the web and add them to your knowledge for future reference.`
          : `At step ${step}, you took the **visit** action and try to visit some URLs but failed to read the content. You need to think out of the box or cut from a completely different angle.`
        );

        updateContext({
          totalStep,
          ...(success ? {
            question: currentQuestion,
            ...thisStep,
            result: urlResults
          } : {
            ...thisStep,
            result: 'You have tried all possible URLs and found no new information. You must think out of the box or different angle!!!'
          })
        });
      } else {
        diaryContext.push(`
At step ${step}, you took the **visit** action. But then you realized you have already visited these URLs and you already know very well about their contents.
You decided to think out of the box or cut from a completely different angle.`);

        updateContext({
          totalStep,
          ...thisStep,
          result: 'You have visited all possible URLs and found no new information. You must think out of the box or different angle!!!'
        });
      }
      allowRead = false;
    }
    else if (thisStep.action === 'coding' && thisStep.codingIssue) {
      const sandbox = new CodeSandbox({allContext, visitedURLs, allURLs, allKnowledge}, context, SchemaGen);
      try {
        const result = await sandbox.solve(thisStep.codingIssue);
        allKnowledge.push({
          question: `What is the solution to the coding issue: ${thisStep.codingIssue}?`,
          answer: result.solution.output,
          sourceCode: result.solution.code,
          type: 'coding',
          updated: new Date().toISOString()
        });
        diaryContext.push(`
At step ${step}, you took the **coding** action and try to solve the coding issue: ${thisStep.codingIssue}.
You found the solution and add it to your knowledge for future reference.
`);
        updateContext({
          totalStep,
          ...thisStep,
          result: result
        });
      } catch (error) {
        console.error('Error solving coding issue:', error);
        diaryContext.push(`
At step ${step}, you took the **coding** action and try to solve the coding issue: ${thisStep.codingIssue}.
But unfortunately, you failed to solve the issue. You need to think out of the box or cut from a completely different angle.
`);
        updateContext({
          totalStep,
          ...thisStep,
          result: 'You have tried all possible solutions and found no new information. You must think out of the box or different angle!!!'
        });
      } finally {
        allowCoding = false;
      }
    }

    await storeContext(system, schema, {allContext, allKeywords, allQuestions, allKnowledge, weightedURLs}, totalStep);
    await sleep(STEP_SLEEP);
  }

  await storeContext(system, schema, {allContext, allKeywords, allQuestions, allKnowledge, weightedURLs}, totalStep);
  if (!(thisStep as AnswerAction).isFinal) {
    console.log('Enter Beast mode!!!')
    // any answer is better than no answer, humanity last resort
    step++;
    totalStep++;
    system = getPrompt(
      diaryContext,
      allQuestions,
      allKeywords,
      false,
      false,
      false,
      false,
      false,
      badContext,
      allKnowledge,
      weightedURLs,
      true,
    );

    schema = SchemaGen.getAgentSchema(false, false, true, false, false, finalAnswerPIP, question);
    const result = await generator.generateObject({
      model: 'agentBeastMode',
      schema,
      system,
      messages
    });
    thisStep = {
      action: result.object.action,
      think: result.object.think,
      ...result.object[result.object.action]
    } as AnswerAction;
    (thisStep as AnswerAction).isFinal = true;
    context.actionTracker.trackAction({totalStep, thisStep, gaps, badAttempts});
  }

  (thisStep as AnswerAction).mdAnswer = buildMdFromAnswer((thisStep as AnswerAction))
  console.log(thisStep)

  await storeContext(system, schema, {allContext, allKeywords, allQuestions, allKnowledge, weightedURLs}, totalStep);

  // max return 300 urls
  const returnedURLs = weightedURLs.slice(0, 300).map(r => r.url);
  return {
    result: thisStep,
    context,
    visitedURLs: returnedURLs,
    readURLs: visitedURLs,
  };
}

async function storeContext(prompt: string, schema: any, memory: {
                              allContext: StepAction[];
                              allKeywords: string[];
                              allQuestions: string[];
                              allKnowledge: KnowledgeItem[];
                              weightedURLs: BoostedSearchSnippet[];
                            }
  , step: number) {

  const {allContext, allKeywords, allQuestions, allKnowledge, weightedURLs} = memory;
  if ((process as any).asyncLocalContext?.available?.()) {

    (process as any).asyncLocalContext.ctx.promptContext = {
      prompt,
      schema,
      allContext,
      allKeywords,
      allQuestions,
      allKnowledge,
      step
    };
    return;
  }

  try {
    await fs.writeFile(`prompt-${step}.txt`, `
Prompt:
${prompt}

JSONSchema:
${JSON.stringify(zodToJsonSchema(schema), null, 2)}
`);
    await fs.writeFile('context.json', JSON.stringify(allContext, null, 2));
    await fs.writeFile('queries.json', JSON.stringify(allKeywords, null, 2));
    await fs.writeFile('questions.json', JSON.stringify(allQuestions, null, 2));
    await fs.writeFile('knowledge.json', JSON.stringify(allKnowledge, null, 2));
    await fs.writeFile('urls.json', JSON.stringify(weightedURLs, null, 2));
  } catch (error) {
    console.error('Context storage failed:', error);
  }
}


export async function main() {
  const question = process.argv[2] || "";
  const {
    result: finalStep,
    context: tracker,
    visitedURLs: visitedURLs
  } = await getResponse(question) as { result: AnswerAction; context: TrackerContext; visitedURLs: string[] };
  console.log('Final Answer:', finalStep.answer);
  console.log('Visited URLs:', visitedURLs);

  tracker.tokenTracker.printSummary();
}

if (require.main === module) {
  main().catch(console.error);
}
