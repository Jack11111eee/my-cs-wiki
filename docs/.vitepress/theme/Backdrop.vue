<script setup>
/* 全屏远景 + 磨砂玻璃。
   三层都是 position:fixed 的叶子节点，靠 z-index 排：
     1  底图（白天樱花 / 夜晚雪夜，切换时交叉淡入）
     3  磨砂玻璃
   4  内容（在 custom.css 里给 .VPContent 加）
   玻璃必须低于 .VPContent——右侧目录 .aside-container 是 fixed 且在 VPContent 内部，
   一旦玻璃压过它，整个目录会被模糊掉。

   注意：底图必须是真实的 DOM 元素，不能改成 body 的 background-image。
   body 的背景会传播到 canvas，那样 backdrop-filter 采不到它，模糊会失效。 */
import sakura from './assets/sakura.webp'
import snow from './assets/snow.webp'
</script>

<template>
  <div class="wiki-bg wiki-bg--day" :style="{ backgroundImage: `url(${sakura})` }" aria-hidden="true" />
  <div class="wiki-bg wiki-bg--night" :style="{ backgroundImage: `url(${snow})` }" aria-hidden="true" />
  <div class="wiki-glass" aria-hidden="true" />
</template>