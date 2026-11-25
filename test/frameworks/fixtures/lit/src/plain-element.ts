import { LitElement, html } from 'lit'

export class PlainElement extends LitElement {
    static properties = { who: { type: String } }
    declare who: string

    constructor() {
        super()
        this.who = 'Lit (plain class)'
    }

    render() {
        return html`<h2 data-testid="hello">Hello from Flight + ${this.who}</h2>`
    }
}

customElements.define('plain-element', PlainElement)
