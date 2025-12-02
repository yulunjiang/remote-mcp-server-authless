import OpenAI from "openai";

var openai = null; // top-level 先放 null

export function initOpenAI(env) {
  openai = new OpenAI({
    apiKey: env.API_HOST
  });
}

export { openai };
