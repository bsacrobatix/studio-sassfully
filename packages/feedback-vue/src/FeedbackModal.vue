<script setup>
import { ref } from "vue";
import { anchorDisplayFields } from "../../feedback-core/src/index.mjs";
import { useFeedbackReporter } from "./useFeedbackReporter.mjs";

const props = defineProps({
  kinds: { type: Array, required: true },
  anchorFor: { type: Function, required: true },
  manifest: { type: Object, required: true },
  router: { type: Object, required: true },
  context: { default: undefined },
});
const emit = defineEmits(["close", "submitted"]);
const reporter = useFeedbackReporter(props);
const text = ref("");
function select(kind) { reporter.choose(kind.id ?? kind.kind ?? kind); text.value = ""; }
function review() { reporter.setText(text.value); reporter.review(); }
async function send() { const receipt = await reporter.submit(); emit("submitted", receipt); }
</script>

<template>
  <section class="fb-modal" role="dialog" aria-modal="true" aria-label="Send feedback">
    <button class="fb-close" type="button" aria-label="Close feedback" @click="emit('close')">×</button>
    <div v-if="reporter.state.phase === 'choose'">
      <h2>What’s this about?</h2>
      <template v-for="(group, index) in kinds" :key="group.label ?? index">
        <h3 v-if="group.kinds">{{ group.label }}</h3>
        <button v-for="kind in (group.kinds ?? [group])" :key="kind.id ?? kind.kind ?? kind" type="button" @click="select(kind)">{{ kind.label ?? kind }}</button>
      </template>
    </div>
    <div v-else-if="reporter.state.phase === 'draft'">
      <h2>{{ reporter.state.kind }}</h2>
      <textarea v-model="text" aria-label="Feedback" />
      <button type="button" @click="review">Review</button>
    </div>
    <div v-else-if="reporter.state.phase === 'review'">
      <h2>Review feedback</h2>
      <p class="fb-verdict" :data-ok="reporter.state.review.verdict.ok">{{ reporter.state.review.verdict.ok ? 'Privacy review passed' : 'Privacy review blocked' }}</p>
      <ul><li v-for="([key, value]) in anchorDisplayFields(reporter.state.review.payload.anchor)" :key="key"><strong>{{ key }}</strong>: {{ value }}</li></ul>
      <pre class="fb-payload">{{ JSON.stringify(reporter.state.review.payload, null, 2) }}</pre>
      <ul v-if="!reporter.state.review.verdict.ok"><li v-for="violation in reporter.state.review.verdict.violations" :key="violation.path">{{ violation.path }}: {{ violation.reason }}</li></ul>
      <button type="button" :disabled="!reporter.state.review.verdict.ok" @click="send">Submit</button>
    </div>
    <div v-else>
      <h2>Feedback sent</h2><p>{{ reporter.state.receipt?.ref }}</p>
    </div>
  </section>
</template>

<style>
.fb-modal { background: var(--fb-bg, #fff); color: var(--fb-fg, #171717); border: 1px solid var(--fb-border, #ccc); padding: 1rem; max-width: 34rem; }
.fb-modal button { color: var(--fb-accent, #155eef); } .fb-close { float: right; } .fb-modal textarea { display: block; width: 100%; min-height: 8rem; }
.fb-verdict[data-ok="false"] { color: var(--fb-danger, #b42318); } .fb-verdict[data-ok="true"] { color: var(--fb-success, #027a48); }
</style>
