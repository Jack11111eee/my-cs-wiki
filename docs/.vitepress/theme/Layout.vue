<script setup>
import DefaultTheme from 'vitepress/theme'
import Backdrop from './Backdrop.vue'
import PetalDissolve from './PetalDissolve.vue'

const { Layout } = DefaultTheme
</script>

<template>
  <Layout>
    <template #layout-top>
      <Backdrop />
      <PetalDissolve />
    </template>
  </Layout>
</template>