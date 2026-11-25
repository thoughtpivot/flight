import { greeting } from './greeting.js'

const target = document.querySelector<HTMLElement>('#app')
if (!target) throw new Error('missing #app')

const heading = document.createElement('h1')
heading.dataset.testid = 'hello'
heading.textContent = greeting('Vanilla')
target.append(heading)
