import './plain-element'
import './decorated-element'

const target = document.getElementById('app')!
target.append(document.createElement('plain-element'), document.createElement('decorated-element'))
