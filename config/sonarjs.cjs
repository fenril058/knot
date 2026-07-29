// SonarJS 4.2.0 の全 plugin 読み込みは、ルートの TypeScript 7 を
// ts-api-utils が参照して失敗する。使用する規則だけを読み込んで衝突を避ける。
// eslint-plugin-sonarjs の更新時は内部パスと規則の読み込みを再検証すること。
const cognitiveComplexity = require('eslint-plugin-sonarjs/cjs/S3776/rule.js').rule;
const noDuplicatedBranches = require('eslint-plugin-sonarjs/cjs/S1871/rule.js').rule;
const noIdenticalFunctions = require('eslint-plugin-sonarjs/cjs/S4144/rule.js').rule;

module.exports = {
  meta: {
    name: 'eslint-plugin-sonarjs',
    version: '4.2.0',
  },
  rules: {
    'cognitive-complexity': cognitiveComplexity,
    'no-duplicated-branches': noDuplicatedBranches,
    'no-identical-functions': noIdenticalFunctions,
  },
};
