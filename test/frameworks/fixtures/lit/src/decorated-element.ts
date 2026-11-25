import { LitElement, html } from 'lit'
import { customElement, property } from 'lit/decorators.js'

@customElement('decorated-element')
export class DecoratedElement extends LitElement {
    @property({ type: String }) who = 'Lit (decorators)'

    render() {
        return html`<h2 data-testid="hello">Hello from Flight + ${this.who}</h2>`
    }
}
