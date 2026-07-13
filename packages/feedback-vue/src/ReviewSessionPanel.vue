<script setup>
import { ref } from "vue";
import { useReviewSession } from "./useReviewSession.mjs";
const props = defineProps({ subject: { type: Object, required: true }, reviewer: { type: String, default: null }, manifest: { type: Object, required: true }, router: { type: Object, required: true } });
const emit = defineEmits(["submitted"]);
const review = useReviewSession(props);
const title = ref(""); const summary = ref(""); const verdict = ref("pending");
async function submit() { const receipt = await review.submit({ title: title.value, summary: summary.value, verdict: verdict.value }); emit("submitted", receipt); }
</script>
<template>
  <section class="fb-review-session" aria-label="Review session">
    <h2>Review session</h2>
    <ol><li v-for="comment in review.state.session.comments" :key="comment.commentId">{{ comment.sequence + 1 }}. {{ comment.commentId }} <button type="button" @click="review.remove(comment.commentId)">Remove</button></li></ol>
    <label>Title <input v-model="title"></label><label>Summary <textarea v-model="summary"></textarea></label><label>Verdict <input v-model="verdict"></label>
    <button type="button" @click="review.reviewSummary({ title, summary, verdict })">Review summary</button>
    <button type="button" :disabled="!review.state.session.comments.length" @click="submit">Submit once</button>
    <p v-if="review.state.receipt">{{ review.state.receipt.receiptId }}</p><p v-if="review.state.error">{{ review.state.error.message }}</p>
  </section>
</template>
